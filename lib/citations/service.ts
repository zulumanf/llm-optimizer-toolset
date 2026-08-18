/**
 * Citation acquisition (spec 060). Discovery aggregates the immutable
 * response_citations ledger per third-party domain; ACVS scores what the
 * aggregation observed; the lifecycle records what an operator decides to do;
 * a placement becomes an intervention so the existing verification/retest/
 * verdict machinery measures whether anything moved. Nothing here claims
 * causation and nothing spends or contacts anyone.
 */
import { z } from "zod";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { getSubjectCompany, listCompaniesForProject } from "@/db/companies";
import { domainLabelsForProject } from "@/db/citation-profiles";
import { domainClassifications } from "@/db/displacement";
import { playbookFor } from "@/lib/sources/playbooks";
import { assertCanWrite, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { firstZodMessage } from "@/lib/service-helpers";
import { getActiveWeightSet } from "@/lib/scoring/weights";
import { safeFetch } from "@/lib/security/safe-fetch";
import { scanAliases } from "@/lib/parsing/prepass";
import { createIntervention } from "@/lib/attribution/service";
import { log } from "@/lib/logger";
import {
  computeAcvs,
  canTransition,
  ACVS_VERSION,
  ACVS_WEIGHT_SET_NAME,
  HIGH_INTENT_MAX_TIER,
  ACQUISITION_PATHS,
  OPPORTUNITY_STATUSES,
  OUTCOME_STATUSES,
  OBTAINABLE_STATUSES,
  HIGH_INTENT_COMPONENT_THRESHOLD,
  type AcquisitionFacts,
  type DomainStats,
  type OpportunityStatus,
} from "@/lib/citations/acvs";

/** Discovery cap: the long tail of one-off citations stays in the ledger,
 * queryable, without minting thousands of opportunity rows. */
export const DISCOVERY_DOMAIN_CAP = 200;
const PRESENCE_FETCH_TIMEOUT_MS = 10_000;
const PRESENCE_FETCH_MAX_BYTES = 2_000_000;

// ---------------------------------------------------------------- stats

interface ProjectCitationData {
  stats: Map<string, DomainStats>;
  /** Domains the ledger attributed to a tracked company (owner by suffix). */
  ownerAttributedDomains: Set<string>;
  /** Normalized apex domains of every tracked company + owned/competitor
   * registry rows — matched by suffix, so subdomains are excluded too. */
  excludedApexes: string[];
}

const normalizeApex = (d: string): string =>
  d.replace(/^www\./, "").toLowerCase().trim();

/** Suffix-aware ownership test: blog.client.com matches client.com — the
 * same convention the parser uses to stamp response_citations.company_id. */
export function domainIsExcluded(domain: string, apexes: string[]): boolean {
  return apexes.some((apex) => domain === apex || domain.endsWith(`.${apex}`));
}

/**
 * Everything ACVS needs about every cited domain in one project, from the
 * ledger + mentions + prompts + presence checks. Mock responses are excluded
 * everywhere — mock fixtures must never mint acquisition targets.
 */
async function gatherProjectCitationData(
  projectId: string
): Promise<ProjectCitationData> {
  // Subject first (the co-occurrence split needs it); the rest is independent.
  const subject = await getSubjectCompany(projectId);
  const [totalsRows, companies, perDomain, coOccurrence, presence, labels] =
    await Promise.all([
      sql`
        select count(*)::int as total_responses,
          count(distinct r.prompt_id)::int as total_prompts,
          count(distinct r.provider)::int as total_providers,
          count(distinct r.run_id)::int as total_runs
        from responses r join runs on runs.id = r.run_id
        where runs.project_id = ${projectId}
          and runs.status in ('completed', 'partial') and r.provider != 'mock'
      `,
      listCompaniesForProject(projectId),
      sql`
        select c.domain,
          count(distinct c.response_id)::int as citing_responses,
          count(distinct r.prompt_id)::int as citing_prompts,
          count(distinct r.provider)::int as providers_citing,
          count(distinct r.run_id)::int as runs_citing,
          bool_or(c.company_id is not null) as owner_attributed,
          count(distinct c.response_id)
            filter (where p.tier is not null)::int as tiered_citing,
          count(distinct c.response_id)
            filter (where p.tier <= ${HIGH_INTENT_MAX_TIER})::int as high_intent_citing
        from response_citations c
        join responses r on r.id = c.response_id
        join runs on runs.id = r.run_id
        left join prompts p on p.id = r.prompt_id
        where runs.project_id = ${projectId}
          and runs.status in ('completed', 'partial') and r.provider != 'mock'
        group by c.domain
      `,
      // Recommendation co-occurrence: current-revision mentions only (the
      // recommendedCitationDomains convention — same answer, nothing more).
      // ONE distinct count over all recommended mentions: an answer that
      // recommends both the client and a rival is one answer, not two.
      sql`
        select c.domain,
          count(distinct m.response_id)::int as answers_with_recommendation,
          count(distinct m.company_id)
            filter (where m.company_id != ${subject?.id ?? null}
              or ${subject === null})::int as competitors_recommended
        from response_citations c
        join responses r on r.id = c.response_id
        join runs on runs.id = r.run_id
        join mentions m on m.response_id = r.id and m.recommended
        where runs.project_id = ${projectId}
          and runs.status in ('completed', 'partial') and r.provider != 'mock'
          and not exists (select 1 from mentions n
            where n.response_id = m.response_id and n.company_id = m.company_id
              and n.revision > m.revision)
        group by c.domain
      `,
      // Presence is page-scoped: present anywhere = present; absent means
      // "not found on the pages checked", so keep the count for honest copy.
      sql`
        select domain, bool_or(client_present) as client_present,
          count(*)::int as checks, max(checked_at) as checked_at
        from source_presence_checks
        where project_id = ${projectId} and ok and client_present is not null
        group by domain
      `,
      domainLabelsForProject(projectId),
    ]);
  const totals = totalsRows[0];
  const tracked = companies.filter((c) => c.id !== subject?.id);

  const co = new Map(coOccurrence.map((r) => [r.domain as string, r]));
  const pres = new Map(presence.map((r) => [r.domain as string, r]));
  const typeByDomain = new Map(labels.map((l) => [l.domain, l.sourceType]));
  const stats = new Map<string, DomainStats>();
  const ownerAttributedDomains = new Set<string>();
  for (const row of perDomain) {
    const domain = row.domain as string;
    if (row.ownerAttributed) ownerAttributedDomains.add(domain);
    const c = co.get(domain);
    const p = pres.get(domain);
    stats.set(domain, {
      domain,
      totalResponses: totals?.totalResponses ?? 0,
      citingResponses: row.citingResponses as number,
      totalPrompts: totals?.totalPrompts ?? 0,
      citingPrompts: row.citingPrompts as number,
      tieredCitingResponses: row.tieredCiting as number,
      highIntentCitingResponses: row.highIntentCiting as number,
      totalProviders: totals?.totalProviders ?? 0,
      providersCiting: row.providersCiting as number,
      totalRuns: totals?.totalRuns ?? 0,
      runsCiting: row.runsCiting as number,
      answersWithRecommendation: (c?.answersWithRecommendation as number) ?? 0,
      competitorsRecommendedDistinct: (c?.competitorsRecommended as number) ?? 0,
      trackedCompetitors: tracked.length,
      clientPresent: p ? (p.clientPresent as boolean | null) : null,
      presenceChecksCount: p ? (p.checks as number) : 0,
      presenceCheckedAt: p ? (p.checkedAt as Date) : null,
      sourceType: typeByDomain.get(domain) ?? null,
    });
  }

  const excludedApexes = [
    ...new Set([
      ...companies.flatMap((c) => (c.domain ? [normalizeApex(c.domain)] : [])),
      ...labels
        .filter((l) => l.relationship === "owned" || l.relationship === "competitor")
        .map((l) => normalizeApex(l.domain)),
    ]),
  ];
  return { stats, ownerAttributedDomains, excludedApexes };
}

/** Public stats view (rescoring, tests). */
export async function projectDomainStats(
  projectId: string
): Promise<Map<string, DomainStats>> {
  return (await gatherProjectCitationData(projectId)).stats;
}

// ------------------------------------------------------------- discovery

export interface DiscoveryResult {
  discovered: number;
  rescored: number;
  skippedExcluded: number;
  cappedAt: number | null;
}

/**
 * Aggregate the ledger, upsert one opportunity per third-party domain, and
 * (re)score everything. Idempotent: re-discovery never touches operator
 * fields or status — only the ACVS snapshot and updated_at move.
 */
export async function discoverOpportunities(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<DiscoveryResult>> {
  const parsed = z.object({ projectId: z.string().uuid() }).safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const { projectId } = parsed.data;
  try {
    assertCanWrite(user);
    const { stats, ownerAttributedDomains, excludedApexes } =
      await gatherProjectCitationData(projectId);
    const allCandidates = [...stats.values()];
    const candidates = allCandidates
      .filter(
        (s) =>
          !ownerAttributedDomains.has(s.domain) &&
          !domainIsExcluded(s.domain, excludedApexes)
      )
      .sort((a, b) => b.citingResponses - a.citingResponses);
    const skippedExcluded = allCandidates.length - candidates.length;
    const kept = candidates.slice(0, DISCOVERY_DOMAIN_CAP);
    if (candidates.length > DISCOVERY_DOMAIN_CAP) {
      log("info", "citations.discovery_capped", {
        projectId,
        dropped: candidates.length - DISCOVERY_DOMAIN_CAP,
      });
    }
    let discovered = 0;
    await sql.begin(async (tx) => {
      // One statement for the whole batch — the per-row loop cost up to 200
      // round-trips inside an open transaction. Same idempotency: existing
      // rows only touch updated_at, operator fields and status never move.
      if (kept.length > 0) {
        // Seed acquisition_path from the source-type playbook (spec 087) at
        // insert time only — an operator's later choice is never overwritten.
        const classified = await domainClassifications(
          projectId,
          kept.map((s) => s.domain)
        );
        const typeByDomain = new Map(
          classified.map((c) => [c.domain, c.sourceType])
        );
        const paths = kept.map((s) => {
          const sourceType = typeByDomain.get(s.domain);
          return (sourceType && playbookFor(sourceType)?.defaultAcquisitionPath) ?? "unknown";
        });
        const rows = await tx`
          insert into citation_opportunities
            (project_id, domain, acquisition_path, created_by)
          select ${projectId}, d.domain, d.path, ${user.id}
          from unnest(
            ${kept.map((s) => s.domain)}::text[],
            ${paths}::text[]
          ) as d(domain, path)
          on conflict (project_id, domain)
            do update set updated_at = now()
          returning (xmax = 0) as inserted
        `;
        discovered = rows.filter((r) => r.inserted).length;
      }
      await writeAudit(tx, {
        userId: user.id,
        action: "citation_opportunity.discover",
        entity: "project",
        entityId: projectId,
        projectId,
        detail: {
          domains: kept.length,
          discovered,
          excluded: skippedExcluded,
          capped: candidates.length > DISCOVERY_DOMAIN_CAP,
        },
      });
    });
    const rescored = await rescoreProject(projectId, stats);
    return ok({
      discovered,
      rescored,
      skippedExcluded,
      cappedAt: candidates.length > DISCOVERY_DOMAIN_CAP ? DISCOVERY_DOMAIN_CAP : null,
    });
  } catch (err) {
    return fail(err);
  }
}

/** Score every opportunity in a project (or just `onlyOpportunityIds`)
 * against fresh stats. A domain no longer observed in the ledger has its
 * score CLEARED, not kept — a stale number presented as current is exactly
 * the fabrication the platform forbids. Returns the rows written. */
export async function rescoreProject(
  projectId: string,
  preloadedStats?: Map<string, DomainStats>,
  onlyOpportunityIds?: string[]
): Promise<number> {
  const stats = preloadedStats ?? (await projectDomainStats(projectId));
  const weightSet = await getActiveWeightSet(ACVS_WEIGHT_SET_NAME);
  const opportunities = await sql`
    select id, domain, acquisition_path, acquisition_difficulty
    from citation_opportunities where project_id = ${projectId}
    ${onlyOpportunityIds ? sql`and id = any(${onlyOpportunityIds})` : sql``}
  `;
  if (opportunities.length === 0) return 0;
  // Scores are computed in memory, then written in ONE statement — the
  // per-row loop cost another ~200 serial round-trips per Discover click.
  const results = opportunities.map((opp) => {
    const domainStats = stats.get(opp.domain as string);
    const facts: AcquisitionFacts = {
      acquisitionPath: opp.acquisitionPath as string,
      acquisitionDifficulty:
        opp.acquisitionDifficulty as AcquisitionFacts["acquisitionDifficulty"],
    };
    return {
      id: opp.id as string,
      ...(domainStats
        ? computeAcvs(domainStats, facts, weightSet)
        : {
            acvs: null,
            components: null,
            explanation: [
              "No longer observed in the current citation ledger — previous score cleared.",
            ],
          }),
    };
  });
  // One jsonb payload keyed by id, not per-column jsonb[] casts — the array
  // route double-encodes through the driver's array serialization.
  const payload = Object.fromEntries(
    results.map((r) => [
      r.id,
      { acvs: r.acvs, components: r.components, explanation: r.explanation },
    ])
  );
  await sql`
    with payload as (select ${sql.json(payload as never)}::jsonb as j)
    update citation_opportunities o set
      acvs = (p.j -> o.id::text ->> 'acvs')::numeric,
      acvs_components = nullif(p.j -> o.id::text -> 'components', 'null'::jsonb),
      acvs_explanation = array(
        select jsonb_array_elements_text(p.j -> o.id::text -> 'explanation')
      ),
      acvs_version = ${ACVS_VERSION},
      acvs_weight_set_version = ${weightSet.version},
      acvs_computed_at = now(),
      updated_at = now()
    from payload p
    where o.id = any(${results.map((r) => r.id)}::uuid[])
  `;
  return results.length;
}

// -------------------------------------------------------------- lifecycle

const updateSchema = z.object({
  opportunityId: z.string().uuid(),
  status: z.enum(OPPORTUNITY_STATUSES).optional(),
  acquisitionPath: z.enum(ACQUISITION_PATHS).optional(),
  acquisitionDifficulty: z.enum(["easy", "moderate", "hard", "unknown"]).optional(),
  estimatedCostUsd: z.number().nonnegative().nullable().optional(),
  estimatedDaysToLive: z.number().int().nonnegative().nullable().optional(),
  contactStatus: z
    .enum(["none", "researching", "found", "contacted", "responded"])
    .optional(),
  eligibilityNotes: z.string().max(2000).nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
  nextAction: z.string().max(500).nullable().optional(),
  providerId: z.string().uuid().nullable().optional(),
});

/** Operator updates: acquisition facts freely; status via the lifecycle
 * rule (forward in pipeline, outcomes only from measuring, exits from any
 * non-terminal state). Every change audited with its diff. */
export async function updateOpportunity(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ opportunityId: string }>> {
  const parsed = updateSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const input = parsed.data;
  try {
    assertCanWrite(user);
    const projectIdForRescore = await sql.begin(async (tx) => {
      const [current] = await tx`
        select id, project_id, status, intervention_id from citation_opportunities
        where id = ${input.opportunityId} for update
      `;
      if (!current) throw new ClassifiedError("not_found", "Opportunity not found.");
      const from = current.status as OpportunityStatus;
      if (input.status && !canTransition(from, input.status)) {
        throw new ClassifiedError(
          "validation",
          `Cannot move a citation opportunity from "${from}" to "${input.status}".`
        );
      }
      // `measuring` is not an operator label — it is the state linkPlacement
      // enters when a real intervention exists, and outcomes are what that
      // intervention's measured verdicts justify. Both refuse without one.
      if (input.status === "measuring") {
        throw new ClassifiedError(
          "validation",
          "Use “Link placement” to start measuring — it creates the intervention that does the measuring."
        );
      }
      if (
        input.status &&
        (OUTCOME_STATUSES as readonly string[]).includes(input.status) &&
        !current.interventionId
      ) {
        throw new ClassifiedError(
          "validation",
          "An outcome needs a measured placement behind it — link the placement first."
        );
      }
      await tx`
        update citation_opportunities set
          status = coalesce(${input.status ?? null}, status),
          acquisition_path = coalesce(${input.acquisitionPath ?? null}, acquisition_path),
          acquisition_difficulty =
            coalesce(${input.acquisitionDifficulty ?? null}, acquisition_difficulty),
          estimated_cost_usd = ${
            input.estimatedCostUsd === undefined
              ? sql`estimated_cost_usd`
              : input.estimatedCostUsd
          },
          estimated_days_to_live = ${
            input.estimatedDaysToLive === undefined
              ? sql`estimated_days_to_live`
              : input.estimatedDaysToLive
          },
          contact_status = coalesce(${input.contactStatus ?? null}, contact_status),
          eligibility_notes = ${
            input.eligibilityNotes === undefined
              ? sql`eligibility_notes`
              : input.eligibilityNotes
          },
          notes = ${input.notes === undefined ? sql`notes` : input.notes},
          next_action = ${
            input.nextAction === undefined ? sql`next_action` : input.nextAction
          },
          provider_id = ${
            input.providerId === undefined ? sql`provider_id` : input.providerId
          },
          updated_at = now()
        where id = ${input.opportunityId}
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "citation_opportunity.update",
        entity: "citation_opportunity",
        entityId: input.opportunityId,
        projectId: current.projectId as string,
        detail: { from, ...input },
      });
      return current.projectId as string;
    });
    // Path/difficulty are ACVS inputs — a row whose score contradicts its own
    // displayed fields is a stale fact, so rescore this opportunity now.
    if (input.acquisitionPath !== undefined || input.acquisitionDifficulty !== undefined) {
      await rescoreProject(projectIdForRescore, undefined, [input.opportunityId]);
    }
    return ok({ opportunityId: input.opportunityId });
  } catch (err) {
    return fail(err);
  }
}

// -------------------------------------------------------- presence checks

/** Enqueue an on-demand presence check (worker fetches; nothing inline). */
export async function requestPresenceCheck(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ domain: string }>> {
  const parsed = z
    .object({ opportunityId: z.string().uuid(), url: z.string().url().optional() })
    .safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  try {
    assertCanWrite(user);
    const [opp] = await sql`
      select project_id, domain from citation_opportunities
      where id = ${parsed.data.opportunityId}
    `;
    if (!opp) return fail(new ClassifiedError("not_found", "Opportunity not found."));
    // Default to the page the engines actually cited, not the homepage — a
    // client featured on an article is invisible from the domain root, and a
    // presence verdict must be about a page we had reason to check.
    let url = parsed.data.url;
    if (!url) {
      const [topCited] = await sql`
        select c.url, count(*)::int as n
        from response_citations c
        join responses r on r.id = c.response_id
        join runs on runs.id = r.run_id
        where runs.project_id = ${opp.projectId as string}
          and c.domain = ${opp.domain as string} and r.provider != 'mock'
        group by c.url order by n desc, c.url asc limit 1
      `;
      url = (topCited?.url as string | undefined) ?? `https://${opp.domain as string}/`;
    }
    await sql`
      insert into jobs (type, payload)
      values ('check_source_presence', ${sql.json({
        projectId: opp.projectId,
        domain: opp.domain,
        url,
        checkedBy: user.id,
      } as never)})
    `;
    return ok({ domain: opp.domain as string });
  } catch (err) {
    return fail(err);
  }
}

/**
 * Worker handler: fetch the source page (SSRF-guarded), scan for the
 * subject's and competitors' names/aliases, append the measured fact.
 * A failed fetch is recorded as a failed check — never invented, never
 * blocking (append-only history, latest OK row wins in stats).
 */
export async function runPresenceCheck(
  payload: {
    projectId: string;
    domain: string;
    url: string;
    checkedBy?: string | null;
  },
  deps: import("@/lib/security/safe-fetch").SafeFetchDeps = {}
): Promise<void> {
  const subject = await getSubjectCompany(payload.projectId);
  const companies = await listCompaniesForProject(payload.projectId);
  let httpStatus: number | null = null;
  let okFlag = false;
  let clientPresent: boolean | null = null;
  let competitorHits: { companyId: string; name: string; matched: string }[] = [];
  let error: string | null = null;
  try {
    const result = await safeFetch(
      payload.url,
      {
        timeoutMs: PRESENCE_FETCH_TIMEOUT_MS,
        maxBytes: PRESENCE_FETCH_MAX_BYTES,
        headers: { "user-agent": "avos-presence-check/1.0" },
      },
      deps
    );
    httpStatus = result.status;
    okFlag = result.ok;
    if (result.ok) {
      // The registered html-v1 extractor, not a local strip: it decodes
      // entities, so "Smith &amp; Co" still matches — a name lost to encoding
      // must never become an immutable "client absent" fact.
      const { htmlExtractor } = await import(
        "@/lib/knowledge/sources/extractors/text"
      );
      const { text } = await htmlExtractor.extract(result.bytes);
      const hits = scanAliases(
        text,
        companies.map((c) => ({ id: c.id, name: c.name, aliases: c.aliases }))
      );
      clientPresent = subject ? hits.some((h) => h.companyId === subject.id) : null;
      competitorHits = hits
        .filter((h) => h.companyId !== subject?.id)
        .map((h) => ({
          companyId: h.companyId,
          name: companies.find((c) => c.id === h.companyId)?.name ?? "",
          matched: h.matched,
        }));
    }
  } catch (err) {
    error = err instanceof Error ? err.message : "Fetch failed.";
  }
  await sql`
    insert into source_presence_checks
      (project_id, domain, url, http_status, ok, client_present,
       competitor_hits, error, checked_by)
    values
      (${payload.projectId}, ${payload.domain}, ${payload.url}, ${httpStatus},
       ${okFlag}, ${clientPresent}, ${sql.json(competitorHits as never)},
       ${error}, ${payload.checkedBy ?? null})
  `;
  log("info", "citations.presence_checked", {
    projectId: payload.projectId,
    domain: payload.domain,
    ok: okFlag,
    clientPresent,
  });
}

// ------------------------------------------------------------- placements

const placementSchema = z.object({
  opportunityId: z.string().uuid(),
  urls: z.array(z.string().url()).min(1).max(10),
  promptSetVersionId: z.string().uuid(),
  shippedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  title: z.string().trim().min(1).max(120).optional(),
  costUsd: z.number().nonnegative().optional(),
});

/**
 * A won placement becomes an intervention — baselines, live URL
 * verification, +2w/+6w/+12w retests, and verdicts come from the existing
 * spec-007/051 machinery. The opportunity moves to `measuring` and carries
 * the intervention id; success/inconclusive is decided later from the
 * intervention's measured verdicts, by a human.
 */
export async function linkPlacement(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ opportunityId: string; interventionId: string }>> {
  const parsed = placementSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const input = parsed.data;
  try {
    assertCanWrite(user);
    const [opp] = await sql`
      select id, project_id, domain, status, intervention_id
      from citation_opportunities where id = ${input.opportunityId}
    `;
    if (!opp) return fail(new ClassifiedError("not_found", "Opportunity not found."));
    if (opp.interventionId) {
      return fail(
        new ClassifiedError("validation", "This opportunity is already being measured.")
      );
    }
    if (!canTransition(opp.status as OpportunityStatus, "measuring")) {
      return fail(
        new ClassifiedError(
          "validation",
          `Cannot start measuring from status "${opp.status as string}".`
        )
      );
    }
    // Claim-first: flip to `measuring` in a guarded UPDATE before creating
    // the intervention, so a double submit loses the claim instead of
    // minting a second intervention with its own scheduled retest runs.
    const claimed = await sql`
      update citation_opportunities
      set status = 'measuring', updated_at = now()
      where id = ${input.opportunityId}
        and status = ${opp.status as string} and intervention_id is null
      returning id
    `;
    if (claimed.length === 0) {
      return fail(
        new ClassifiedError(
          "conflict",
          "This opportunity changed while you were editing — reload and retry."
        )
      );
    }
    const created = await createIntervention(user, {
      projectId: opp.projectId,
      title: input.title ?? `Citation placement: ${opp.domain as string}`,
      hypothesis: `Inclusion on ${opp.domain as string} correlates with improved AI visibility for tracked prompts.`,
      shippedAt: input.shippedAt,
      urls: input.urls,
      promptSetVersionId: input.promptSetVersionId,
      costUsd: input.costUsd,
    });
    if (!created.ok) {
      // Release the claim — the placement was not recorded.
      await sql`
        update citation_opportunities
        set status = ${opp.status as string}, updated_at = now()
        where id = ${input.opportunityId} and intervention_id is null
      `;
      return fail(created.error);
    }
    await sql.begin(async (tx) => {
      await tx`
        update citation_opportunities
        set intervention_id = ${created.data.interventionId}, updated_at = now()
        where id = ${input.opportunityId}
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "citation_opportunity.placement_linked",
        entity: "citation_opportunity",
        entityId: input.opportunityId,
        projectId: opp.projectId as string,
        detail: {
          interventionId: created.data.interventionId,
          urls: input.urls,
          baselineWeak: created.data.baselineWeak,
        },
      });
    });
    return ok({
      opportunityId: input.opportunityId,
      interventionId: created.data.interventionId,
    });
  } catch (err) {
    return fail(err);
  }
}

// --------------------------------------------------------------- reading

export interface GapFilters {
  statuses?: OpportunityStatus[];
  paths?: string[];
  clientAbsentOnly?: boolean;
  highIntentOnly?: boolean;
  minAcvs?: number;
}

export interface GapRow {
  id: string;
  domain: string;
  status: OpportunityStatus;
  acquisitionPath: string;
  acquisitionDifficulty: string;
  contactStatus: string;
  nextAction: string | null;
  providerId: string | null;
  interventionId: string | null;
  acvs: number | null;
  acvsComponents: Record<string, number | null> | null;
  acvsExplanation: string[] | null;
  acvsComputedAt: Date | null;
  clientPresent: boolean | null;
  updatedAt: Date;
}

/** The citation gap view: opportunities + latest presence verdict,
 * filterable. High-intent = commercialIntent component ≥ 0.5. */
export async function citationGapView(
  projectId: string,
  filters: GapFilters = {}
): Promise<GapRow[]> {
  const rows = await sql`
    select o.id, o.domain, o.status, o.acquisition_path, o.acquisition_difficulty,
      o.contact_status, o.next_action, o.provider_id, o.intervention_id,
      o.acvs, o.acvs_components, o.acvs_explanation, o.acvs_computed_at,
      o.updated_at, p.client_present
    from citation_opportunities o
    left join lateral (
      select client_present from source_presence_checks c
      where c.project_id = o.project_id and c.domain = o.domain and c.ok
      order by c.checked_at desc limit 1
    ) p on true
    where o.project_id = ${projectId}
      ${filters.statuses?.length ? sql`and o.status = any(${filters.statuses})` : sql``}
      ${filters.paths?.length ? sql`and o.acquisition_path = any(${filters.paths})` : sql``}
      ${filters.clientAbsentOnly ? sql`and p.client_present = false` : sql``}
      ${
        filters.highIntentOnly
          ? sql`and (o.acvs_components->>'commercialIntent')::numeric
              >= ${HIGH_INTENT_COMPONENT_THRESHOLD}`
          : sql``
      }
      ${filters.minAcvs === undefined ? sql`` : sql`and o.acvs >= ${filters.minAcvs}`}
    order by o.acvs desc nulls last, o.domain asc
  `;
  return rows.map(
    (r): GapRow => ({
        id: r.id as string,
        domain: r.domain as string,
        status: r.status as OpportunityStatus,
        acquisitionPath: r.acquisitionPath as string,
        acquisitionDifficulty: r.acquisitionDifficulty as string,
        contactStatus: r.contactStatus as string,
        nextAction: r.nextAction as string | null,
        providerId: r.providerId as string | null,
        interventionId: r.interventionId as string | null,
        acvs: r.acvs === null ? null : Number(r.acvs),
        acvsComponents: r.acvsComponents as Record<string, number | null> | null,
        acvsExplanation: r.acvsExplanation as string[] | null,
        acvsComputedAt: r.acvsComputedAt as Date | null,
      clientPresent: r.clientPresent as boolean | null,
      updatedAt: r.updatedAt as Date,
    })
  );
}

export interface RunCitationMetrics {
  uniqueSourceDomains: number;
  clientCitedResponses: number;
  competitorCitedResponses: number;
  thirdPartyDomains: number;
  /** Third-party domains with an opportunity at qualified or later. */
  obtainableGaps: number;
}

/** Prospecting/report counts for one run — observation language only.
 * "The client" is the run's project SUBJECT (never the global is_self flag:
 * on a prospect benchmark the subject is the prospect, and the exact bug
 * this fixes reported the subject's cited sources as a competitor's). */
export async function citationMetricsForRun(
  runId: string
): Promise<RunCitationMetrics> {
  const [run] = await sql`select project_id from runs where id = ${runId}`;
  const subject = run ? await getSubjectCompany(run.projectId as string) : null;
  const [counts] = await sql`
    select count(distinct c.domain)::int as unique_domains,
      count(distinct c.response_id)
        filter (where c.company_id = ${subject?.id ?? null})::int as client_cited,
      count(distinct c.response_id)
        filter (where c.company_id is not null
          and (c.company_id != ${subject?.id ?? null} or ${subject === null}))::int
        as competitor_cited,
      count(distinct c.domain) filter (where c.company_id is null)::int as third_party
    from response_citations c
    join responses r on r.id = c.response_id
    where r.run_id = ${runId} and r.provider != 'mock'
  `;
  // Obtainable gaps are scoped to THIS run's cited domains — a project-wide
  // pipeline count is not a statement about this run's answers.
  const [obtainable] = run
    ? await sql`
        select count(*)::int as n from citation_opportunities o
        where o.project_id = ${run.projectId}
          and o.status = any(${[...OBTAINABLE_STATUSES]})
          and o.domain in (
            select distinct c.domain from response_citations c
            join responses r on r.id = c.response_id
            where r.run_id = ${runId} and r.provider != 'mock'
          )
      `
    : [{ n: 0 }];
  return {
    uniqueSourceDomains: (counts?.uniqueDomains as number) ?? 0,
    clientCitedResponses: (counts?.clientCited as number) ?? 0,
    competitorCitedResponses: (counts?.competitorCited as number) ?? 0,
    thirdPartyDomains: (counts?.thirdParty as number) ?? 0,
    obtainableGaps: (obtainable?.n as number) ?? 0,
  };
}

// -------------------------------------------------------------- providers
// The acquisition_providers registry table ships with migration 069; its
// write service and UI land together when provider tracking is actually
// used — a mutation endpoint nothing calls is dead surface, not readiness.
