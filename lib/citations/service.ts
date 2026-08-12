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

/**
 * Everything ACVS needs about every cited domain in one project, from the
 * ledger + mentions + prompts + presence checks. Mock responses are excluded
 * everywhere — mock fixtures must never mint acquisition targets.
 */
export async function projectDomainStats(
  projectId: string
): Promise<Map<string, DomainStats>> {
  const [totals] = await sql`
    select count(*)::int as total_responses,
      count(distinct r.prompt_id)::int as total_prompts,
      count(distinct r.provider)::int as total_providers,
      count(distinct r.run_id)::int as total_runs
    from responses r join runs on runs.id = r.run_id
    where runs.project_id = ${projectId}
      and runs.status in ('completed', 'partial') and r.provider != 'mock'
  `;
  const subject = await getSubjectCompany(projectId);
  const tracked = (await listCompaniesForProject(projectId)).filter(
    (c) => c.id !== subject?.id
  );
  const perDomain = await sql`
    select c.domain,
      count(distinct c.response_id)::int as citing_responses,
      count(distinct r.prompt_id)::int as citing_prompts,
      count(distinct r.provider)::int as providers_citing,
      count(distinct r.run_id)::int as runs_citing,
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
  `;
  // Recommendation co-occurrence: current-revision mentions only (the
  // recommendedCitationDomains convention — same answer, nothing more).
  const coOccurrence = await sql`
    select c.domain,
      count(distinct m.response_id)
        filter (where m.company_id != ${subject?.id ?? null}
          or ${subject === null})::int as competitor_rec_responses,
      count(distinct m.company_id)
        filter (where m.company_id != ${subject?.id ?? null}
          or ${subject === null})::int as competitors_recommended,
      count(distinct m.response_id)
        filter (where m.company_id = ${subject?.id ?? null})::int as client_rec_responses
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
  `;
  const presence = await sql`
    select distinct on (domain) domain, client_present, checked_at
    from source_presence_checks
    where project_id = ${projectId} and ok
    order by domain, checked_at desc
  `;
  const labels = await domainLabelsForProject(projectId);

  const co = new Map(coOccurrence.map((r) => [r.domain as string, r]));
  const pres = new Map(presence.map((r) => [r.domain as string, r]));
  const typeByDomain = new Map(labels.map((l) => [l.domain, l.sourceType]));
  const stats = new Map<string, DomainStats>();
  for (const row of perDomain) {
    const domain = row.domain as string;
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
      competitorRecommendedCoOccurrence: (c?.competitorRecResponses as number) ?? 0,
      competitorsRecommendedDistinct: (c?.competitorsRecommended as number) ?? 0,
      trackedCompetitors: tracked.length,
      clientRecommendedCoOccurrence: (c?.clientRecResponses as number) ?? 0,
      clientPresent: p ? (p.clientPresent as boolean | null) : null,
      presenceCheckedAt: p ? (p.checkedAt as Date) : null,
      sourceType: typeByDomain.get(domain) ?? null,
    });
  }
  return stats;
}

/** Domains that are not acquisition targets: the subject's and every tracked
 * company's own domains, plus registry rows labeled owned/competitor. */
async function excludedDomains(projectId: string): Promise<Set<string>> {
  const companies = await listCompaniesForProject(projectId);
  const excluded = new Set<string>();
  for (const c of companies) {
    if (c.domain) excluded.add(c.domain.replace(/^www\./, "").toLowerCase());
  }
  for (const label of await domainLabelsForProject(projectId)) {
    if (label.relationship === "owned" || label.relationship === "competitor") {
      excluded.add(label.domain);
    }
  }
  return excluded;
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
    const stats = await projectDomainStats(projectId);
    const excluded = await excludedDomains(projectId);
    const candidates = [...stats.values()]
      .filter((s) => !excluded.has(s.domain))
      .sort((a, b) => b.citingResponses - a.citingResponses);
    const kept = candidates.slice(0, DISCOVERY_DOMAIN_CAP);
    if (candidates.length > DISCOVERY_DOMAIN_CAP) {
      log("info", "citations.discovery_capped", {
        projectId,
        dropped: candidates.length - DISCOVERY_DOMAIN_CAP,
      });
    }
    let discovered = 0;
    await sql.begin(async (tx) => {
      for (const s of kept) {
        const [row] = await tx`
          insert into citation_opportunities (project_id, domain, created_by)
          values (${projectId}, ${s.domain}, ${user.id})
          on conflict (project_id, domain)
            do update set updated_at = now()
          returning (xmax = 0) as inserted
        `;
        if (row?.inserted) discovered += 1;
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
          excluded: excluded.size,
          capped: candidates.length > DISCOVERY_DOMAIN_CAP,
        },
      });
    });
    const rescored = await rescoreProject(projectId, stats);
    return ok({
      discovered,
      rescored,
      skippedExcluded: excluded.size,
      cappedAt: candidates.length > DISCOVERY_DOMAIN_CAP ? DISCOVERY_DOMAIN_CAP : null,
    });
  } catch (err) {
    return fail(err);
  }
}

/** Score every opportunity in a project against fresh stats. Returns count. */
export async function rescoreProject(
  projectId: string,
  preloadedStats?: Map<string, DomainStats>
): Promise<number> {
  const stats = preloadedStats ?? (await projectDomainStats(projectId));
  const weightSet = await getActiveWeightSet(ACVS_WEIGHT_SET_NAME);
  const opportunities = await sql`
    select id, domain, acquisition_path, acquisition_difficulty
    from citation_opportunities where project_id = ${projectId}
  `;
  let scored = 0;
  for (const opp of opportunities) {
    const domainStats = stats.get(opp.domain as string);
    if (!domainStats) continue;
    const facts: AcquisitionFacts = {
      acquisitionPath: opp.acquisitionPath as string,
      acquisitionDifficulty:
        opp.acquisitionDifficulty as AcquisitionFacts["acquisitionDifficulty"],
    };
    const result = computeAcvs(domainStats, facts, weightSet);
    await sql`
      update citation_opportunities set
        acvs = ${result.acvs},
        acvs_components = ${sql.json(result.components as never)},
        acvs_explanation = ${result.explanation},
        acvs_version = ${ACVS_VERSION},
        acvs_weight_set_version = ${weightSet.version},
        acvs_computed_at = now(),
        updated_at = now()
      where id = ${opp.id as string}
    `;
    scored += 1;
  }
  return scored;
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
    await sql.begin(async (tx) => {
      const [current] = await tx`
        select id, project_id, status from citation_opportunities
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
    });
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
    const url = parsed.data.url ?? `https://${opp.domain as string}/`;
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

/** Crude tag strip for alias scanning — enough for "does the name appear". */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");
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
      const text = htmlToText(result.bytes.toString("utf8"));
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
    const created = await createIntervention(user, {
      projectId: opp.projectId,
      title: input.title ?? `Citation placement: ${opp.domain as string}`,
      hypothesis: `Inclusion on ${opp.domain as string} correlates with improved AI visibility for tracked prompts.`,
      shippedAt: input.shippedAt,
      urls: input.urls,
      promptSetVersionId: input.promptSetVersionId,
      costUsd: input.costUsd,
    });
    if (!created.ok) return fail(created.error);
    await sql.begin(async (tx) => {
      await tx`
        update citation_opportunities
        set status = 'measuring', intervention_id = ${created.data.interventionId},
          updated_at = now()
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
    order by o.acvs desc nulls last, o.domain asc
  `;
  return rows
    .map(
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
    )
    .filter((r) => !filters.statuses?.length || filters.statuses.includes(r.status))
    .filter((r) => !filters.paths?.length || filters.paths.includes(r.acquisitionPath))
    .filter((r) => !filters.clientAbsentOnly || r.clientPresent === false)
    .filter(
      (r) =>
        !filters.highIntentOnly ||
        (r.acvsComponents?.commercialIntent ?? 0) >= 0.5
    )
    .filter((r) => filters.minAcvs === undefined || (r.acvs ?? -1) >= filters.minAcvs);
}

export interface RunCitationMetrics {
  uniqueSourceDomains: number;
  clientCitedResponses: number;
  competitorCitedResponses: number;
  thirdPartyDomains: number;
  /** Third-party domains with an opportunity at qualified or later. */
  obtainableGaps: number;
}

/** Prospecting/report counts for one run — observation language only. */
export async function citationMetricsForRun(
  runId: string
): Promise<RunCitationMetrics> {
  const [run] = await sql`select project_id from runs where id = ${runId}`;
  const [counts] = await sql`
    select count(distinct c.domain)::int as unique_domains,
      count(distinct c.response_id) filter (where comp.is_self)::int as client_cited,
      count(distinct c.response_id)
        filter (where comp.id is not null and not comp.is_self)::int as competitor_cited,
      count(distinct c.domain) filter (where c.company_id is null)::int as third_party
    from response_citations c
    join responses r on r.id = c.response_id
    left join companies comp on comp.id = c.company_id
    where r.run_id = ${runId} and r.provider != 'mock'
  `;
  const [obtainable] = run
    ? await sql`
        select count(*)::int as n from citation_opportunities
        where project_id = ${run.projectId}
          and status in ('qualified', 'prioritized', 'outreach_ready',
            'outreach_in_progress', 'negotiation', 'submitted', 'won', 'live',
            'verified', 'measuring')
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

const providerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  providerType: z.enum([
    "outreach_agency",
    "citation_marketplace",
    "pr_platform",
    "journalist_platform",
    "directory_network",
    "manual_outreach",
    "internal_team",
    "partner_network",
  ]),
  placementTypes: z.array(z.string().max(60)).max(20).default([]),
  costNotes: z.string().max(1000).nullable().optional(),
  turnaroundNotes: z.string().max(1000).nullable().optional(),
  restrictions: z.string().max(1000).nullable().optional(),
  qualityNotes: z.string().max(1000).nullable().optional(),
  active: z.boolean().default(true),
});

/** Declarative provider registry rows — no integration, no spending. */
export async function upsertProvider(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ providerId: string }>> {
  const parsed = providerSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const p = parsed.data;
  try {
    assertCanWrite(user);
    const result = await sql.begin(async (tx) => {
      const [row] = await tx`
        insert into acquisition_providers
          (name, provider_type, placement_types, cost_notes, turnaround_notes,
           restrictions, quality_notes, active, created_by)
        values
          (${p.name}, ${p.providerType}, ${p.placementTypes},
           ${p.costNotes ?? null}, ${p.turnaroundNotes ?? null},
           ${p.restrictions ?? null}, ${p.qualityNotes ?? null}, ${p.active},
           ${user.id})
        on conflict (name) do update set
          provider_type = excluded.provider_type,
          placement_types = excluded.placement_types,
          cost_notes = excluded.cost_notes,
          turnaround_notes = excluded.turnaround_notes,
          restrictions = excluded.restrictions,
          quality_notes = excluded.quality_notes,
          active = excluded.active,
          updated_at = now()
        returning id
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "acquisition_provider.upsert",
        entity: "acquisition_provider",
        entityId: row!.id as string,
        detail: { name: p.name, providerType: p.providerType },
      });
      return row!.id as string;
    });
    return ok({ providerId: result });
  } catch (err) {
    return fail(err);
  }
}
