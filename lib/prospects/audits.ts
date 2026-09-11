/**
 * Prospect audit pages (split from service.ts 2026-08-17 — pure move, no
 * behavior change): the publish/expire/revoke lifecycle and the public
 * token read. Everything here was written under specs 032/045/052/057/065/
 * 076/077; see those and the git history of lib/prospects/service.ts.
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { assertCanWrite, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { firstZodMessage } from "@/lib/service-helpers";
import {
  AUDIT_LINK_DEFAULT_EXPIRY_DAYS,
  AUDIT_TOKEN_BYTES,
  COMMISSION_RATE_ESTIMATE,
  SENDER_COMPANY,
  SENDER_CREDENTIAL,
  FRESHNESS_WINDOWS_DAYS,
  staleness,
  findProhibitedPhrase,
  visibilityThreshold,
  AUDIT_TRANSCRIPT_CAP,
} from "@/lib/prospects/constants";
import { PROMPT_ECHO_EXCLUDED } from "@/lib/scoring/prompt-echo";
import { latestVerifiedProduction } from "@/lib/prospects/realtrends";
import { getActiveSenderIdentity } from "@/lib/outreach/sender-identity";
import {
  CURRENT,
  promptEvidenceForResponses,
  runSummary,
  scoredEntities,
  type PromptEvidence,
} from "@/lib/prospects/benchmark";
import { checkNoMockResponses, deadSourceLinks } from "@/lib/qa/preflight";
import { mockScoringAllowed } from "@/lib/ai/registry";
// removed-unused: auditUrl
import {} from "@/lib/prospects/urls";
import {
  ensureAuditLink,
  revokeAuditLinks,
} from "@/lib/prospects/links";
import { revokeReportSessions } from "@/lib/prospects/report-access";
import { log } from "@/lib/logger";
import {
  getPrimaryFinding,
  lockProspect,
  logActivity,
  readProspect,
  launchMarketName,
} from "@/lib/prospects/shared";
import { authorityGapForRun } from "@/lib/prospects/gap";
import { diagnoseProspect } from "@/lib/prospects/diagnose";
import { apiSurface, measurementPurpose } from "@/lib/runs/provenance";
import { classifySource } from "@/lib/sources/classify";
import { surfaceCategory } from "@/lib/prospects/terminology";
import { normalizeDomain } from "@/lib/knowledge/normalize";
import { computeProspectScoreView } from "@/lib/prospects/final-score";
import { validateAuditEvidence } from "@/lib/prospects/audit-evidence";
import { todayIso } from "@/lib/prospects/constants";
import { mismatchBlockForProspect, type AuditMismatchBlock } from "@/lib/prospects/audit-mismatch";

const PROSPECT_FACING_DIAGNOSES: Record<string, string> = {
  no_organic_visibility: "AI doesn't surface you yet",
  missing_from_high_intent_prompts: "Missing exactly where buyers decide",
  mentioned_never_recommended: "Known, but not recommended",
  // Observed, not causal (Team Moza review 2026-08-19): the benchmark
  // counts citations; it does not prove what the models "read" or why.
  missing_from_cited_sources: "Your site wasn't among the cited sources",
  competitors_dominate_sources: "Competitor-owned pages dominate the cited sources",
};

/** Rivals on the prospect-facing audit comparison — the visible market. */
const AUDIT_COMPARISON_RIVALS = 7;
const PROMPT_EVIDENCE_LIMIT = 4;

// ---------------------------------------------------------------------------
// Prospect audit pages

/**
 * A prospect-visible observation with its receipt. Spec 045 §2b as written
 * (spec 052 fencing): every prospect-visible entry REQUIRES its source —
 * publisher, URL, and date — because an unsourced observation is exactly
 * the artifact a skeptical team owner discredits first. One shape, one
 * schema factory; previously written four times.
 */
export interface SourcedObservation {
  text: string;
  sourceLabel: string;
  sourceUrl: string;
  sourceDate: string;
}

function sourcedObservationSchema(textMin: number, textMax: number) {
  return z.object({
    text: z.string().trim().min(textMin).max(textMax),
    sourceLabel: z.string().trim().min(2).max(120),
    sourceUrl: z.string().trim().url().max(1000),
    sourceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  });
}

/** One comparison-row shape for the prospect and rival branches. */
function toComparisonRow(
  entity: {
    mentionRate: number | null;
    recommendationRate: number | null;
    sampleSize: number;
    scoreIds?: Record<string, string>;
  },
  name: string,
  isProspect: boolean,
  marketRank: number | null
): AuditSnapshot["comparison"][number] {
  return {
    name,
    isProspect,
    mentionRate: entity.mentionRate,
    recommendationRate: entity.recommendationRate,
    sampleSize: entity.sampleSize,
    marketRank,
    scoreIds: entity.scoreIds,
  };
}

export interface AuditSnapshot {
  headline: string;
  prospectName: string;
  marketName: string;
  benchmark: {
    dateRange: { from: string; to: string | null };
    providers: string[];
    promptCount: number;
    responseCount: number;
    limitations: string;
  };
  /** Instrument versions frozen at publish (spec 065): the scoring and
   * parser versions the numbers were computed with, so a snapshot can be
   * re-verified against exactly the methodology that produced it. Optional:
   * pre-065 snapshots render without it (presentation-only rule). */
  instrumentVersions?: { scoring: string[]; parser: string[] };
  /** How the observations were collected (spec 086), derived from stored
   * instrument facts at publish. Optional: pre-086 snapshots render without
   * it. searchEnabled + modelOnly = responseCount. */
  collection?: {
    method: "api";
    searchEnabled: number;
    modelOnly: number;
    purpose: string;
  };
  /** Staff-recorded clean-session consumer observations (spec 011) on the
   * same benchmark project, summarized per platform with their OWN
   * denominator — never merged into the API counts above. Present only when
   * observations exist. */
  consumerValidation?: {
    observations: number;
    mentioned: number;
    byProvider: { provider: string; observations: number; mentioned: number }[];
    performedFrom: string;
    performedTo: string;
  };
  keyFinding: {
    title: string;
    explanation: string;
    metrics: Record<string, unknown>;
  };
  comparison: {
    name: string;
    isProspect: boolean;
    mentionRate: number | null;
    recommendationRate: number | null;
    sampleSize: number;
    /** Sourced market rank (ranking signal with a numeric value, same
     * launch); null for entities with no ranked record — never guessed. */
    marketRank?: number | null;
    /** metric → immutable scores row id (spec 052). Optional: snapshots
     * published before the binding existed render without it; NEW snapshots
     * are refused at publish unless every rendered rate is bound and
     * matches its score row (validateAuditEvidence). */
    scoreIds?: Record<string, string>;
  }[];
  /** Brand-level names (brokerages, out-of-market brands) that filled the
   * answers — kept out of the team table, summarized beneath it. The
   * first-mover argument: no individual team owns the answers yet. */
  brandMentions?: {
    name: string;
    mentionRate: number | null;
    recommendationRate: number | null;
    /** Sub-brands whose names extend this brand's (e.g. "Corcoran Sawyer
     * Smith" under "Corcoran") — nested so overlap never reads as
     * double-counting. Additive; older snapshots render flat. */
    children?: {
      name: string;
      mentionRate: number | null;
      recommendationRate: number | null;
    }[];
  }[];
  promptEvidence: PromptEvidence[];
  methodology: string;
  cta: string;
  /** Spec 128: the mismatch "private report" — frozen side-by-side plus
   * the exact questions and answers. Present only for prospects who
   * received a competitive-mismatch Touch 1; the page renders the compact
   * variant when set. */
  mismatch?: AuditMismatchBlock;
  /** THE PROOF (spec 045): every captured answer, complete and verbatim, so
   * the reader can search for their own name and find nothing — an absence
   * can only be proven by publishing everything. Rendered on the appendix
   * page (/audit/[token]/answers). */
  transcripts?: {
    prompt: string;
    provider: string;
    model: string;
    capturedAt: string;
    answer: string;
  }[];
  /** How many qualifying answers the run captured in total (launch fix
   * 2026-08-14). The pages claim "every answer is published" ONLY when
   * transcripts.length equals this; when AUDIT_TRANSCRIPT_CAP truncated the
   * list they state shown-of-total instead. Additive: legacy snapshots lack
   * it and never claim completeness. */
  transcriptTotal?: number;
  /** Short verbatim moments where an assistant recommended a rival —
   * the machine in its own words, stamped. */
  evidenceExcerpts?: {
    quote: string;
    teamName: string;
    model: string;
    capturedAt: string;
    /** The question that produced the answer (additive, spec 048). */
    promptText?: string;
  }[];
  /** Independently verified production (RealTrends upgrade 2026-08-15):
   * rendered as "Verified market performance" with its EXACT ranking scope —
   * a category-specific #1 never reads as an overall-market #1. Additive:
   * older snapshots render the legacy track-record line. */
  verifiedProduction?: {
    source: string;
    rank: number | null;
    rankScope: string;
    scopeComparable: boolean;
    volumeUsd: number;
    sides: number;
    avgPerSideUsd: number | null;
    productionYear: number | null;
    sourceUrl: string;
    retrievedOn: string;
  };
  /** Spec 039's computed fixability, embedded only when measured — turns
   * "we are losing" into "this is winnable" without inventing a number.
   * Strengths are its top measured categories: counted facts, not promises. */
  fixability?: {
    version: string;
    score: number;
    confidence: number | null;
    strengths: string[];
  };
  /** Who stands behind the report. */
  preparedBy?: {
    name: string;
    date: string;
    reportId: string;
    /** Reply-to for the one-click CTA (spec 045 CRO pass). */
    email?: string;
    /** Sender credibility (PR B, P5e) — env-configured, optional. */
    company?: string;
    credential?: string;
  };
  /** Dollar stake (PR B, P5a): commission on ONE side at the prospect's
   * sourced average sale, at a labeled estimate rate. Arithmetic, never a
   * loss claim. */
  commissionEstimate?: { ratePct: number; amountUsd: number };
  /** One manually-researched, verifiable observation (PR B, P5c). Sources
   * required per spec 045 §2b (spec 052 fencing). */
  humanFinding?: SourcedObservation;
  /** Objection pre-empt (PR B, P5b) — renders only when supplied. */
  adoptionStat?: SourcedObservation;
  /** Live consumer-app share links (spec 045): operator-created exhibits on
   * the assistant vendor's own domain. Demos, never measurements. */
  exampleChats?: {
    url: string;
    assistant: string;
    question: string;
    capturedOn: string;
  }[];
  /** What invisibility means in the prospect's own numbers — measured
   * recommendation moments plus arithmetic on THEIR cited volume/sides.
   * Never a fabricated loss claim (PROHIBITED_PHRASES discipline). */
  stakes?: {
    /** Specific-team recommendations assistants made across the answers. */
    recommendationMomentsTotal: number;
    /** How many of those were the prospect. */
    yourRecommendations: number;
    /** Split of the total: individual teams vs brokerage brands (P3 —
     * the table shows teams only, so the headline must not imply the
     * total is all teams). Additive; older snapshots lack them. */
    teamRecommendations?: number;
    brandRecommendations?: number;
    /** Sourced record facts (PR B): the strong side of the contrast now
     * that the numeric authority score is gone from the page. */
    volumeUsd?: number | null;
    sides?: number | null;
    /** Who got named instead, most-recommended first. */
    competitorsNamed: string[];
    /** volume ÷ sides from their own sourced signals; null when unknown. */
    avgDealUsd: number | null;
    /** The cited numbers the average is computed from. */
    avgDealBasis: string | null;
  };
  /** Prospect-facing "why this is happening" (spec 042 diagnoses, whitelist
   * only — internal research-gap diagnoses never ship to a prospect). */
  whyItHappens?: {
    title: string;
    /** Measured facts (spec 086) — absent on snapshots published before v2. */
    observations?: string[];
    explanation: string;
    suggestedAction: string;
  }[];
  /** The domains the AI answers actually cited. `category` says what a
   * surface is TO THE PROSPECT (spec 086 classifier at publish time):
   * owned / platform / earned are realistic surfaces; competitor-owned is
   * diagnostic context, never an optimization target. Additive — older
   * snapshots render uncategorized. */
  topSources?: {
    domain: string;
    citations: number;
    category?: "owned" | "platform" | "earned" | "competitor" | null;
  }[];
  /** Spec 038 — present only when both sides were measurable at publish
   * time. Additive: audits published before the field render unchanged. */
  authorityGap?: {
    authorityVersion: string;
    visibilityVersion: string;
    authorityScore: number;
    visibilityScore: number;
    gap: number;
    confidence: number | null;
    components: { label: string; points: number; maxPoints: number }[];
    organicResponses: number;
    /** Counted evidence statements only — provenance-labeled, source-linked. */
    signals: {
      label: string;
      provenance: string;
      sourceUrl: string | null;
      /** Evidence classification badge (migration 074/085): independent /
       * self_reported / sponsored / derived. Additive — older snapshots
       * render the plain provenance text as before. */
      sourceType?: string | null;
    }[];
  };
}

const METHODOLOGY_TEXT =
  "Prompts were selected to represent realistic buyer and seller questions for this market and " +
  "run repeatedly against the listed AI models through their providers' official developer " +
  "interfaces. Responses were captured verbatim and parsed for " +
  "which businesses each engine mentioned or recommended. Rates are the share of captured " +
  "responses in which a business appeared. AI responses are probabilistic: individual answers " +
  "vary, which is why sample sizes are shown and why no single response is treated as a result.";

const LIMITATIONS_TEXT =
  "Rates reflect the monitored prompt set and engines during the benchmark window only. They " +
  "are observations of AI assistant behaviour, not measurements of revenue, lead flow, or " +
  "market share.";

export async function publishAudit(
  user: CurrentUser,
  raw: unknown
): Promise<
  ActionResult<{
    auditId: string;
    accessToken: string;
    replaced: boolean;
    /** Publish-time quality flags for the OPERATOR (never in the snapshot):
     * e.g. rank tracks visibility in this market, which weakens the pitch —
     * grounds to disqualify rather than send a soft audit (PR B amendment 4). */
    warnings: string[];
  }>
> {
  const parsed = z
    .object({
      prospectId: z.string().uuid(),
      expiresAt: z.string().datetime().optional(),
      /** A stale benchmark (spec 042 freshness windows) publishes only with
       * this explicit acknowledgment, which is recorded in the audit log. */
      acknowledgeStale: z.boolean().optional(),
      /** PR B, P5c: one manually-researched, verifiable observation about
       * this prospect's public footprint. The highest-value block on the
       * page — it proves a human looked. Dev mode renders a loud warning
       * when absent; production renders nothing rather than something
       * generic. */
      humanFinding: sourcedObservationSchema(20, 600).optional(),
      /** PR B, P5b: adoption-stat objection pre-empt. Renders only when
       * both the stat and its source are supplied — never a placeholder in
       * front of a prospect. */
      adoptionStat: sourcedObservationSchema(10, 300).optional(),
      /** Spec 052: warnings are advisories with teeth — publishing over
       * them requires an explicit acknowledgment with a recorded reason. */
      acknowledgeWarnings: z
        .object({ reason: z.string().trim().min(10).max(500) })
        .optional(),
    })
    .safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const input = parsed.data;
  try {
    assertCanWrite(user);
    // Spec 052 fencing: the two operator-typed blocks are the highest-
    // persuasion text on the page and were the only prospect-visible
    // strings that skipped the prohibited-phrase check.
    for (const [label, text] of [
      ["humanFinding", input.humanFinding?.text],
      ["adoptionStat", input.adoptionStat?.text],
    ] as const) {
      const banned = text ? findProhibitedPhrase(text) : null;
      if (banned) {
        return fail(
          new ClassifiedError(
            "validation",
            `The ${label} contains prohibited wording ("${banned}") — revenue/causality claims never ship to a prospect.`
          )
        );
      }
    }
    // Assembly phase: every read below is a plain pooled query — no
    // transaction, no locks. The data is point-in-time-close rather than
    // snapshot-perfect, which publishing always was; what matters is that
    // assembly can never starve the pool or hold locks across helpers.
    const prospect = await readProspect(input.prospectId);
    const finding = await getPrimaryFinding(sql, input.prospectId);
    const [benchmark] = await sql`
      select id, run_id, company_id from prospect_benchmarks
      where id = ${finding.benchmarkId}
    `;
    if (!benchmark) throw new ClassifiedError("not_found", "Benchmark not found.");

    const run = await runSummary(benchmark.runId as string);
    if (!run) throw new ClassifiedError("not_found", "Run not found.");

    // Run-health gate (launch fix 2026-08-14): an audit assembled from a run
    // that is still executing — or one that captured nothing — would state
    // coverage that was never achieved. Hard block, never acknowledgeable.
    // A PARTIAL run goes through the disqualifying-warning path below
    // instead: publishable, but only with a recorded reason.
    if (run.status !== "completed" && run.status !== "partial") {
      throw new ClassifiedError(
        "validation",
        `The benchmark run is ${run.status}${
          run.statusDetail ? ` (${run.statusDetail})` : ""
        } — only a finished run with captured answers can be published.`
      );
    }
    if (run.responseCount === 0) {
      throw new ClassifiedError(
        "validation",
        "The benchmark run has no valid captured answers — there is nothing to publish."
      );
    }

    // QA preflight blocker (spec 065): defense in depth behind the scoring
    // guard — a mock-fed audit must be unpublishable at every layer.
    {
      const providerRows = await sql`
        select distinct provider from responses where run_id = ${benchmark.runId}
      `;
      const mockCheck = checkNoMockResponses(
        providerRows.map((r) => r.provider as string),
        mockScoringAllowed()
      );
      if (!mockCheck.ok) {
        throw new ClassifiedError(
          "validation",
          `QA preflight blocked publish: ${mockCheck.detail}`
        );
      }
    }

    const benchmarkAge = staleness(run.startedAt, FRESHNESS_WINDOWS_DAYS.benchmark);
    if (benchmarkAge.stale && !input.acknowledgeStale) {
      throw new ClassifiedError(
        "validation",
        `The benchmark run is ${benchmarkAge.ageDays} days old — past the ${FRESHNESS_WINDOWS_DAYS.benchmark}-day freshness window. Re-run the benchmark, or publish anyway with an explicit acknowledgment.`
      );
    }
    const entities = await scoredEntities(benchmark.runId as string);
    const prospectMetrics = entities.find((e) => e.companyId === benchmark.companyId);
    // The comparison shows who actually shows up in the run — top rivals
    // by visibility, not just the ones the approved finding referenced.
    // When the linked run belongs to a CLIENT project, the client's own
    // brand is excluded: it must never appear on a prospect-facing page.
    const [runProject] = await sql`
      select p.kind, p.subject_company_id from projects p
      join runs r on r.project_id = p.id
      where r.id = ${benchmark.runId}
    `;
    const excludedCompanyId =
      runProject?.kind === "client" &&
      runProject?.subjectCompanyId !== benchmark.companyId
        ? (runProject?.subjectCompanyId as string | null)
        : null;
    // Teams vs brands, decided by DATA: a company is a "team" when it maps
    // to a non-brokerage prospect in this launch. Teams go in the table
    // (apples to apples); brands are summarized beneath it.
    const launchTypeRows = await sql`
      select company_id, prospect_type from prospects
      where launch_id = ${prospect.launchId}
        and company_id is not null and archived_at is null
    `;
    const teamCompanyIds = new Set(
      launchTypeRows
        .filter((r) => r.prospectType !== "brokerage")
        .map((r) => r.companyId as string)
    );
    const visibleRivals = entities
      .filter((e) => e.companyId !== benchmark.companyId)
      .filter((e) => e.companyId !== excludedCompanyId)
      .filter((e) => (e.mentionRate ?? 0) > 0 || (e.recommendationRate ?? 0) > 0)
      .sort(
        (a, b) =>
          (b.recommendationRate ?? 0) - (a.recommendationRate ?? 0) ||
          (b.mentionRate ?? 0) - (a.mentionRate ?? 0)
      );
    const rivals = visibleRivals
      .filter((e) => teamCompanyIds.has(e.companyId))
      .slice(0, AUDIT_COMPARISON_RIVALS);
    // Brand nesting (P3): "Corcoran" and "Corcoran Sawyer Smith" as sibling
    // rows read as double-counting — the parser can genuinely credit both
    // for one answer. A brand whose name extends another brand's name (word
    // prefix) nests under it. Heuristic, stated as such; counts unchanged.
    const flatBrands = visibleRivals
      .filter((e) => !teamCompanyIds.has(e.companyId))
      .slice(0, 5)
      .map((e) => ({
        name: e.name,
        mentionRate: e.mentionRate,
        recommendationRate: e.recommendationRate,
        children: [] as {
          name: string;
          mentionRate: number | null;
          recommendationRate: number | null;
        }[],
      }));
    const brandMentions = flatBrands.filter((brand) => {
      const parent = flatBrands.find(
        (candidate) =>
          candidate !== brand && brand.name.startsWith(`${candidate.name} `)
      );
      if (parent) parent.children.push(brand);
      return !parent;
    });
    const evidence = await promptEvidenceForResponses(
      finding.responseIds,
      PROMPT_EVIDENCE_LIMIT
    );

    const marketName = await launchMarketName(sql, prospect.launchId, "your market");

    // Authority vs valuable visibility (spec 038) — included only when
    // both sides are measurable; a one-sided "gap" would be a fabrication.
    const gapView = await authorityGapForRun(
      input.prospectId,
      benchmark.runId as string,
      benchmark.companyId as string
    );
    const countedIds = new Set(gapView.authority.components.flatMap((c) => c.signalIds));
    const authorityGap =
      gapView.gap !== null && gapView.visibility !== null
        ? {
            authorityVersion: gapView.authority.version,
            visibilityVersion: gapView.visibility.version,
            authorityScore: gapView.authority.score as number,
            visibilityScore: gapView.visibility.score as number,
            gap: gapView.gap,
            confidence: gapView.authority.confidence,
            components: gapView.authority.components.map((c) => ({
              label: c.label,
              points: c.points,
              maxPoints: c.maxPoints,
            })),
            organicResponses: gapView.visibility.organicResponses,
            signals: gapView.signals
              .filter((s) => countedIds.has(s.id))
              .map((s) => ({
                label: s.label,
                provenance: s.provenance,
                sourceUrl: s.sourceUrl,
                sourceType: s.sourceType,
              })),
          }
        : undefined;

    // Prospect-facing "why" — whitelist only; internal research-gap and
    // QA diagnoses never ship to a prospect.
    const diagnosisReport = await diagnoseProspect(input.prospectId);
    const whyItHappens = diagnosisReport.diagnoses
      .filter((d) => d.key in PROSPECT_FACING_DIAGNOSES)
      .slice(0, 3)
      .map((d) => ({
        title: PROSPECT_FACING_DIAGNOSES[d.key]!,
        observations: d.observations,
        explanation: d.explanation,
        suggestedAction: d.suggestedAction,
      }));
    // Sourced market ranks for every company in this launch (ranking
    // signals with a numeric value, most recent per prospect) — lets the
    // comparison show "#9 in the market → 0% in the answers" per row.
    // Scope guard (migration 074): ranks are only comparable within ONE
    // ranking scope — a category-specific #1 (scope_comparable=false) never
    // enters cross-company rank math, and mixed scopes are filtered to the
    // prospect's own scope (legacy unscoped rows compare only to each other).
    const rankRows = await sql`
      select distinct on (p.company_id) p.company_id, s.value_number,
        s.metadata->>'rank_scope' as rank_scope
      from prospects p
      join prospect_authority_signals s on s.prospect_id = p.id
        and s.kind = 'ranking' and s.value_number is not null
        and coalesce(s.metadata->>'scope_comparable', 'true') != 'false'
      where p.launch_id = ${prospect.launchId}
        and p.company_id is not null and p.archived_at is null
      order by p.company_id, s.created_at desc
    `;
    const prospectRankScope =
      (rankRows.find((r) => r.companyId === benchmark.companyId)?.rankScope as
        | string
        | null) ?? null;
    const rankByCompany = new Map<string, number>(
      rankRows
        .filter(
          (r) => ((r.rankScope as string | null) ?? null) === prospectRankScope
        )
        .map((r) => [r.companyId as string, Number(r.valueNumber)])
    );

    // Stakes: every "recommended" mention is a real moment an assistant
    // pointed a buyer at a specific team — counted, not estimated. Echo is
    // excluded per company (the organic rule): a recommendation on a
    // question that NAMED that team measures our question, not the market.
    const recRows = await sql`
      select m.company_id, c.name, count(*)::int as recs
      from mentions m
      join companies c on c.id = m.company_id
      join responses r on r.id = m.response_id
      where r.run_id = ${benchmark.runId} and r.error is null and m.recommended
        and ${CURRENT}
        and ${PROMPT_ECHO_EXCLUDED}
      group by m.company_id, c.name
      order by recs desc
    `;
    const recommendationMomentsTotal = recRows.reduce((a, r) => a + Number(r.recs), 0);
    // The total spans teams AND brokerage brands; the comparison table shows
    // teams only. Publishing the split keeps the headline honest (P3) — and
    // the brand share is the open-space argument, not a caveat: AI defaults
    // to brand names when no individual team gives it a reason not to.
    const teamRecommendations = recRows
      .filter(
        (r) =>
          teamCompanyIds.has(r.companyId as string) ||
          r.companyId === benchmark.companyId
      )
      .reduce((a, r) => a + Number(r.recs), 0);
    const brandRecommendations = recommendationMomentsTotal - teamRecommendations;
    const yourRecommendations = Number(
      recRows.find((r) => r.companyId === benchmark.companyId)?.recs ?? 0
    );
    const competitorsNamed = recRows
      .filter((r) => r.companyId !== benchmark.companyId)
      .slice(0, 5)
      .map((r) => r.name as string);
    // Average sale = arithmetic on THEIR cited numbers, never an estimate.
    const [dealBasis] = await sql`
      select
        (select value_number from prospect_authority_signals
          where prospect_id = ${input.prospectId} and kind = 'transaction_volume'
            and value_number is not null order by created_at desc limit 1) as volume,
        (select value_number from prospect_authority_signals
          where prospect_id = ${input.prospectId} and kind = 'transaction_count'
            and value_number is not null order by created_at desc limit 1) as sides
    `;
    const volume = dealBasis?.volume === null ? null : Number(dealBasis?.volume);
    const sides = dealBasis?.sides === null ? null : Number(dealBasis?.sides);
    const avgDealUsd =
      volume !== null && sides !== null && sides > 0 ? Math.round(volume / sides) : null;
    const stakes = {
      recommendationMomentsTotal,
      teamRecommendations,
      brandRecommendations,
      yourRecommendations,
      competitorsNamed,
      // The sourced record as FIELDS (PR B, P1): with the numeric authority
      // score gone, these facts ARE the strong side of the contrast.
      volumeUsd: volume,
      sides,
      avgDealUsd,
      avgDealBasis:
        avgDealUsd !== null
          ? `$${(volume! / 1_000_000).toFixed(2)}M across ${sides} sides, per the sourced record below`
          : null,
    };

    // THE PROOF: every valid answer, complete and verbatim. An absence can
    // only be proven by publishing everything — a reader can search these
    // for their own name. transcriptTotal is stored alongside so the page
    // claims completeness ONLY when the cap did not truncate; a capped list
    // is disclosed as shown-of-total, never silently (launch fix 2026-08-14).
    const [transcriptCount] = await sql`
      select count(*)::int as total from responses
      where run_id = ${benchmark.runId} and error is null
        and response_text is not null
    `;
    const transcriptTotal = Number(transcriptCount?.total ?? 0);
    const transcriptRows = await sql`
      select prompt_text, provider, model, requested_at, response_text
      from responses
      where run_id = ${benchmark.runId} and error is null
        and response_text is not null
      order by prompt_text, provider, repetition
      limit ${AUDIT_TRANSCRIPT_CAP}
    `;
    const transcripts = transcriptRows.map((r) => ({
      prompt: r.promptText as string,
      provider: r.provider as string,
      model: r.model as string,
      capturedAt: (r.requestedAt as Date).toISOString(),
      answer: r.responseText as string,
    }));

    // Short verbatim moments: an assistant recommending a rival, in its
    // own words. Organic only (echo exclusion), one per rival, top 3.
    const excerptRows = await sql`
      select distinct on (m.company_id)
        m.excerpt, c.name, r.model, r.requested_at, r.prompt_text
      from mentions m
      join companies c on c.id = m.company_id
      join responses r on r.id = m.response_id
      where r.run_id = ${benchmark.runId} and r.error is null
        and m.recommended and m.excerpt is not null
        and m.company_id != ${benchmark.companyId}
        and ${CURRENT}
        and ${PROMPT_ECHO_EXCLUDED}
      order by m.company_id, r.requested_at asc
    `;
    const evidenceExcerpts = excerptRows.slice(0, 3).map((r) => ({
      quote: r.excerpt as string,
      teamName: r.name as string,
      model: r.model as string,
      capturedAt: (r.requestedAt as Date).toISOString(),
      // The question makes the excerpt land: "asked X, answered Y" beats
      // a floating quote (conversion pass, spec 048).
      promptText: r.promptText as string,
    }));

    // Fixability (spec 039) — the emotion changes from "we are losing" to
    // "this is winnable". Embedded only when actually computed (adjusted
    // non-null); strengths are its top measured categories, counted facts.
    const scoreView = await computeProspectScoreView(input.prospectId);
    const fixabilityProfileView = scoreView.fixability;
    const fixability =
      fixabilityProfileView.adjusted !== null
        ? {
            version: fixabilityProfileView.version as string,
            score: Math.round(fixabilityProfileView.adjusted),
            confidence: fixabilityProfileView.confidence,
            strengths: fixabilityProfileView.categories
              .filter((c) => c.maxPoints > 0 && c.points / c.maxPoints >= 0.5)
              .sort((a, b) => b.points / b.maxPoints - a.points / a.maxPoints)
              .slice(0, 3)
              .map((c) => c.label),
          }
        : null;

    // Verified market performance (RealTrends upgrade): the strongest
    // authority statement the page can make, with its exact ranking scope.
    const verifiedProduction = await latestVerifiedProduction(input.prospectId);

    // The page's reply CTA mails preparedBy.email — that must be the legal
    // sender identity's reply-to (the mailbox outreach transmits from), not
    // the publishing operator's login account (spec 052 sender identity).
    const senderIdentity = await getActiveSenderIdentity();
    const preparedBy = {
      name: senderIdentity?.senderName ?? user.name,
      email: senderIdentity?.replyToEmail ?? user.email,
      date: todayIso(),
      reportId: randomBytes(4).toString("hex"),
      // Sender credibility (PR B, P5e) — env-configured template fields,
      // never hardcoded prose; absent values render nothing.
      ...(SENDER_COMPANY ? { company: SENDER_COMPANY } : {}),
      ...(SENDER_CREDENTIAL ? { credential: SENDER_CREDENTIAL } : {}),
    };

    // Dollar stake (PR B, P5a): arithmetic on THEIR sourced numbers at a
    // configurable, labeled estimate rate — never a loss claim.
    const commissionEstimate =
      avgDealUsd !== null
        ? {
            ratePct: Number((COMMISSION_RATE_ESTIMATE * 100).toFixed(2)),
            amountUsd: Math.round(avgDealUsd * COMMISSION_RATE_ESTIMATE),
          }
        : null;

    // Live exhibits: allowlisted consumer-app share links (spec 045).
    const exhibitRows = await sql`
      select url, assistant, question, captured_on::text as captured_on
      from prospect_exhibits
      where prospect_id = ${input.prospectId} and archived_at is null
      order by captured_on desc, created_at desc
      limit 5
    `;
    const exampleChats = exhibitRows.map((r) => ({
      url: r.url as string,
      assistant: r.assistant as string,
      question: r.question as string,
      capturedOn: r.capturedOn as string,
    }));

    const sourceRows = await sql`
      select c.domain, count(*)::int as citations
      from response_citations c
      join responses r on r.id = c.response_id
      where r.run_id = ${benchmark.runId}
      group by c.domain
      order by citations desc
      limit 5
    `;
    // Actionability classification (Team Moza review 2026-08-19): the same
    // spec-086 classifier the source graph uses, so a competitor-owned
    // domain renders as diagnostic context and is never prescribed as a
    // surface to get listed on. Unclassifiable domains stay uncategorized.
    const [subjectSite] = await sql`
      select p.website, c.domain as company_domain
      from prospects p
      left join companies c on c.id = p.company_id
      where p.id = ${input.prospectId}
    `;
    const rivalDomainRows = await sql`
      select domain from companies
      where archived_at is null and domain is not null
        and id != ${benchmark.companyId}
    `;
    const rawSubjectSite =
      (subjectSite?.website as string | null) ??
      (subjectSite?.companyDomain as string | null);
    const subjectDomain = rawSubjectSite
      ? normalizeDomain(rawSubjectSite) || null
      : null;
    const competitorDomains = rivalDomainRows
      .map((r) => normalizeDomain(r.domain as string))
      .filter((d) => Boolean(d));
    const topSources = sourceRows.map((s) => {
      const category = surfaceCategory(
        classifySource(normalizeDomain(s.domain as string), {
          subjectDomain,
          competitorDomains,
        })
      );
      return {
        domain: s.domain as string,
        citations: Number(s.citations),
        ...(category ? { category } : {}),
      };
    });

    // Fallback reads correctly inside "questions about {marketName}" —
    // "the monitored market" produced a broken sentence on the page.
    // marketName resolved above via launchMarketName (fallback "your market").
    const headline =
      authorityGap && authorityGap.gap >= 20
        ? `${prospect.businessName} is one of ${marketName}'s strongest teams — and AI assistants almost never say so.`
        : `Your real-world market position appears stronger than your AI market position.`;

    // The snapshot IS the page. Internal fields (notes, scores, owners,
    // rationales) are structurally absent, not filtered at render time.
    const mismatch = await mismatchBlockForProspect(input.prospectId, {
      topSources,
      ownSiteCited: whyItHappens.some((w) => /your (own )?site (did not|didn't|wasn't|was not)/i.test(`${w.title} ${w.explanation}`))
        ? false
        : null,
    });
    const snapshot: AuditSnapshot = {
      headline,
      prospectName: prospect.businessName,
      marketName,
      benchmark: {
        dateRange: {
          from: run.startedAt.toISOString(),
          to: run.completedAt?.toISOString() ?? null,
        },
        providers: run.providers,
        promptCount: run.promptCount,
        responseCount: run.responseCount,
        limitations: LIMITATIONS_TEXT,
      },
      keyFinding: {
        title: finding.title,
        explanation: finding.explanation,
        metrics: finding.metrics,
      },
      // One row shape for both branches — the field wiring (scoreIds,
      // marketRank) must evolve in exactly one place.
      comparison: [
        ...(prospectMetrics
          ? [toComparisonRow(prospectMetrics, prospect.businessName, true,
              rankByCompany.get(benchmark.companyId as string) ?? null)]
          : []),
        ...rivals.map((r) =>
          toComparisonRow(r, r.name, false, rankByCompany.get(r.companyId) ?? null)
        ),
      ],
      promptEvidence: evidence,
      methodology: METHODOLOGY_TEXT,
      cta: "Review the full benchmark with us.",
      ...(authorityGap ? { authorityGap } : {}),
      ...(brandMentions.length > 0 ? { brandMentions } : {}),
      ...(recommendationMomentsTotal > 0 ? { stakes } : {}),
      ...(whyItHappens.length > 0 ? { whyItHappens } : {}),
      ...(topSources.length > 0 ? { topSources } : {}),
      ...(transcripts.length > 0 ? { transcripts, transcriptTotal } : {}),
      ...(evidenceExcerpts.length > 0 ? { evidenceExcerpts } : {}),
      ...(fixability ? { fixability } : {}),
      ...(verifiedProduction ? { verifiedProduction } : {}),
      ...(commissionEstimate ? { commissionEstimate } : {}),
      ...(input.humanFinding ? { humanFinding: input.humanFinding } : {}),
      ...(input.adoptionStat ? { adoptionStat: input.adoptionStat } : {}),
      ...(exampleChats.length > 0 ? { exampleChats } : {}),
      ...(mismatch ? { mismatch } : {}),
      preparedBy,
    };

    // Instrument stamp (spec 065): the snapshot froze numbers with no record
    // of the methodology that produced them — stamp the scoring and parser
    // versions so the artifact can be re-verified against exactly them.
    {
      const [versions] = await sql`
        select
          (select coalesce(array_agg(distinct s.scoring_version), '{}')
             from scores s where s.run_id = ${benchmark.runId}) as scoring,
          (select coalesce(array_agg(distinct m.parser_version), '{}')
             from mentions m join responses r on r.id = m.response_id
             where r.run_id = ${benchmark.runId}) as parser
      `;
      snapshot.instrumentVersions = {
        scoring: (versions?.scoring as string[]) ?? [],
        parser: (versions?.parser as string[]) ?? [],
      };
    }

    // Collection provenance (spec 086): how the observations were collected,
    // derived from instrument facts stored at capture time. All benchmark
    // responses are API-collected by construction (the executor is the only
    // writer of `responses`); the split states how many ran with live web
    // search versus model-only.
    {
      const facts = await sql`
        select provider, model, request_params from responses
        where run_id = ${benchmark.runId} and error is null
      `;
      const searchEnabled = facts.filter(
        (f) =>
          apiSurface({
            provider: f.provider as string,
            model: f.model as string,
            requestParams: f.requestParams as { tools?: string[] } | null,
          }) === "web_search"
      ).length;
      const [runFacts] = await sql`
        select r.trigger, p.kind,
          (select ir.role from intervention_runs ir
            where ir.run_id = r.id limit 1) as intervention_role
        from runs r join projects p on p.id = r.project_id
        where r.id = ${benchmark.runId}
      `;
      snapshot.collection = {
        method: "api",
        searchEnabled,
        modelOnly: facts.length - searchEnabled,
        purpose: measurementPurpose({
          projectKind: (runFacts?.kind as "client" | "prospect") ?? "prospect",
          trigger: (runFacts?.trigger as "manual" | "scheduled") ?? "manual",
          interventionRole:
            (runFacts?.interventionRole as "baseline" | "post" | null) ?? null,
        }),
      };

      // Consumer validation (spec 011 workflow): staff-recorded clean-session
      // observations on the same benchmark project. Separate table, separate
      // denominator — never merged into the API counts, per the 011 rule that
      // client-performed observations never enter benchmark metrics.
      const [cv] = await sql`
        select count(o.id)::int as observations,
          count(o.id) filter (where o.claimed_mentioned)::int as mentioned,
          min(o.performed_on)::text as performed_from,
          max(o.performed_on)::text as performed_to
        from client_validation_observations o
        join client_validation_runs vr on vr.id = o.validation_run_id
        where vr.project_id = (select project_id from runs where id = ${benchmark.runId})
      `;
      if (cv && (cv.observations as number) > 0) {
        const byProvider = await sql`
          select o.provider,
            count(o.id)::int as observations,
            count(o.id) filter (where o.claimed_mentioned)::int as mentioned
          from client_validation_observations o
          join client_validation_runs vr on vr.id = o.validation_run_id
          where vr.project_id = (select project_id from runs where id = ${benchmark.runId})
          group by o.provider
          order by o.provider
        `;
        snapshot.consumerValidation = {
          observations: cv.observations as number,
          mentioned: cv.mentioned as number,
          byProvider: byProvider.map((p) => ({
            provider: p.provider as string,
            observations: p.observations as number,
            mentioned: p.mentioned as number,
          })),
          performedFrom: cv.performedFrom as string,
          performedTo: cv.performedTo as string,
        };
      }
    }

    // Publish-time quality flags for the OPERATOR (PR B amendment 4) —
    // returned, logged, never placed in the snapshot. The big one: if rank
    // TRACKS visibility in this market, the "visibility doesn't follow
    // rank" pitch is weak and the prospect may deserve disqualifying, not
    // a soft audit.
    const publishWarnings: string[] = [];
    // Disqualification signals (spec 052): warnings that say "this pitch is
    // wrong for this prospect" block publish without an explicit
    // acknowledgment. Quality nudges (missing humanFinding) stay advisory.
    const disqualifyingWarnings: string[] = [];
    // Partial-run integrity (launch fix 2026-08-14): failed cells never
    // reach the numbers (every query filters `error is null`), but shipping
    // an audit over a run with holes is a decision, not a default — the
    // operator publishes it only with a recorded reason.
    if (run.status === "partial" || run.failedCount > 0) {
      const attempted = run.responseCount + run.failedCount;
      disqualifyingWarnings.push(
        `The benchmark run is incomplete${
          run.statusDetail ? ` (${run.statusDetail})` : ""
        }: ${run.responseCount} of ${attempted} attempted answers were captured, and the audit's numbers cover only those. Re-run for full coverage, or acknowledge with a reason.`
      );
    }
    {
      const ranked = snapshot.comparison.filter(
        (r) => r.marketRank != null && r.recommendationRate != null
      );
      if (ranked.length >= 3) {
        const byRank = [...ranked].sort((a, b) => a.marketRank! - b.marketRank!);
        const byRecs = [...ranked].sort(
          (a, b) => (b.recommendationRate ?? 0) - (a.recommendationRate ?? 0)
        );
        // Spearman rho between rank position and recommendation position.
        let d2 = 0;
        for (const row of ranked) {
          const ri = byRank.indexOf(row);
          const vi = byRecs.indexOf(row);
          d2 += (ri - vi) ** 2;
        }
        const n = ranked.length;
        const rho = 1 - (6 * d2) / (n * (n * n - 1));
        if (rho >= 0.5) {
          disqualifyingWarnings.push(
            `Rank tracks AI visibility in this market (rho=${rho.toFixed(2)} over ${n} ranked teams) — the "visibility doesn't follow rank" argument is weak for this prospect. Consider disqualifying rather than sending a soft audit.`
          );
        }
      }
      if (!input.humanFinding) {
        publishWarnings.push(
          "No humanFinding supplied — the audit ships without its highest-value block (the one that proves a human looked)."
        );
      }
      // A prospect already recommended at rival-level frequency has no
      // visibility gap to sell against; the page will fall back to the
      // generator headline, and the operator should reconsider sending.
      if (snapshot.stakes) {
        const recs = snapshot.stakes.yourRecommendations;
        const responses = snapshot.benchmark.responseCount;
        if (recs >= visibilityThreshold(responses)) {
          disqualifyingWarnings.push(
            `Prospect is already recommended in ${recs} of ${responses} answers — the visibility-gap pitch does not apply. Consider disqualifying or reframing before sending.`
          );
        }
      }
    }

    // Source-link liveness (spec 065): every receipt the prospect can click
    // gets fetched through the platform's one egress policy. A dead link is
    // an ack-required warning, not a hard block — a transiently-down site
    // must not stop an operator who verified it by hand.
    {
      const sourceUrls = [
        input.humanFinding?.sourceUrl,
        input.adoptionStat?.sourceUrl,
        ...exampleChats.map((c) => c.url),
        ...(authorityGap?.signals ?? []).map((s) => s.sourceUrl),
      ].filter((u): u is string => Boolean(u));
      for (const link of await deadSourceLinks(sourceUrls)) {
        disqualifyingWarnings.push(
          `Dead source link: ${link.url} (${link.note}) — a receipt the prospect cannot open. Fix it, or acknowledge with a reason.`
        );
      }
    }

    // Sense-check gate (spec 077): the agent's concern-severity findings
    // join the disqualification machinery ONLY when the stored check read
    // exactly what is being published (content hash match). A stale or
    // absent check is advisory — the agent is an assistant, never a
    // permission — and polish-severity findings never gate.
    {
      const { assembleAuditContent, contentHash, latestSenseCheck, serializeAuditContent } =
        await import("@/lib/prospects/sense-check");
      const check = await latestSenseCheck(input.prospectId, finding.id);
      if (!check) {
        publishWarnings.push(
          "No sense-check has been run on this audit — consider running it before sending."
        );
      } else if (check.error) {
        publishWarnings.push(
          "The last sense-check failed to complete — its absence is not a clean bill."
        );
      } else {
        const { content } = await assembleAuditContent(input.prospectId, {
          humanFinding: input.humanFinding?.text ?? null,
          adoptionStat: input.adoptionStat?.text ?? null,
        });
        const publishingHash = contentHash(serializeAuditContent(content));
        if (publishingHash !== check.contentHash) {
          publishWarnings.push(
            "The audit content changed after its last sense-check — re-run it to make the check current."
          );
        } else {
          for (const concern of check.concerns) {
            if (concern.severity === "concern") {
              disqualifyingWarnings.push(
                `Sense-check (${concern.area}): ${concern.detail}`
              );
            }
          }
        }
      }
    }

    // Spec 052: warnings that say "consider disqualifying" are not
    // decorations. Publishing over them requires an explicit
    // acknowledgment with a written reason, recorded in the audit log —
    // the operator can still ship, but never without deciding to.
    if (disqualifyingWarnings.length > 0 && !input.acknowledgeWarnings) {
      throw new ClassifiedError(
        "validation",
        `Publish blocked by ${disqualifyingWarnings.length} disqualification signal(s): ${disqualifyingWarnings
          .map((w) => `"${w}"`)
          .join(" · ")} — acknowledge with a reason to publish anyway.`
      );
    }

    // Evidence gate (spec 052): every rate in the comparison must match its
    // referenced immutable score row — the prospect-facing equivalent of the
    // client report's citation gate. Deterministic; refuses on any mismatch.
    const evidenceMismatches = await validateAuditEvidence(snapshot);
    if (evidenceMismatches.length > 0) {
      throw new ClassifiedError(
        "validation",
        `Audit evidence gate failed — ${evidenceMismatches
          .slice(0, 3)
          .map((m) => `${m.row}: ${m.problem}`)
          .join(" · ")}`
      );
    }

    // Commit phase (correctness audit 2026-08-04): the snapshot above was
    // assembled on ordinary pooled reads — the transaction below holds row
    // locks only for the token supersede + insert, so a slow assembly can
    // no longer hold locks while waiting for a second pool connection
    // (the old shape deadlocked the 10-connection pool under concurrency).
    const result = await sql.begin(async (tx) => {
      await lockProspect(tx, input.prospectId);
      // Stable links (057): a live audit is SUPERSEDED in place — the token
      // moves to the successor so the prospect's link never changes. Revoke
      // remains the burn-the-link path; a fresh token is minted only then.
      const [existing] = await tx`
        select id, access_token from prospect_audits
        where prospect_id = ${input.prospectId} and status = 'published'
        for update
      `;
      const accessToken =
        (existing?.accessToken as string | null) ??
        randomBytes(AUDIT_TOKEN_BYTES).toString("base64url");
      if (existing) {
        // Vacate the token first (unique index), freeze the old snapshot as
        // superseded — the lock trigger allows exactly this transition.
        await tx`
          update prospect_audits set status = 'superseded', access_token = null
          where id = ${existing.id}
        `;
        await writeAudit(tx, {
          userId: user.id,
          action: "prospect.audit_supersede",
          entity: "prospect_audit",
          entityId: existing.id as string,
          detail: { prospectId: input.prospectId },
        });
      }
      const [row] = await tx`
        insert into prospect_audits
          (prospect_id, finding_id, headline, snapshot, status, access_token,
           expires_at, published_by, published_at, created_by)
        values (${input.prospectId}, ${finding.id}, ${snapshot.headline},
          ${tx.json(snapshot as never)}, 'published', ${accessToken},
          ${input.expiresAt ??
            new Date(Date.now() + AUDIT_LINK_DEFAULT_EXPIRY_DAYS * 86_400_000)},
          ${user.id}, now(), ${user.id})
        returning id
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "prospect.audit_publish",
        entity: "prospect_audit",
        entityId: row?.id as string,
        detail: {
          prospectId: input.prospectId,
          findingId: finding.id,
          ...(benchmarkAge.stale
            ? { staleBenchmarkAcknowledged: true, benchmarkAgeDays: benchmarkAge.ageDays }
            : {}),
          ...(disqualifyingWarnings.length > 0 && input.acknowledgeWarnings
            ? {
                warningsAcknowledged: disqualifyingWarnings,
                warningsAcknowledgedReason: input.acknowledgeWarnings.reason,
              }
            : {}),
        },
      });
      await logActivity(
        tx,
        input.prospectId,
        "audit_published",
        { auditId: row?.id },
        user.id
      );
      return {
        auditId: row?.id as string,
        accessToken,
        replaced: Boolean(existing),
        warnings: [...disqualifyingWarnings, ...publishWarnings],
      };
    });
    // Branded link (spec 076): a first publication auto-mints the
    // /audit/<slug>/<key> front door. AFTER the publish transaction and
    // isolated — a mint failure must never fail a publish that committed.
    // Supersedes keep the existing link by construction (it points at the
    // prospect, not the snapshot).
    if (!result.replaced) {
      try {
        await sql.begin((tx) =>
          ensureAuditLink(tx, user.id, input.prospectId, prospect.businessName)
        );
      } catch (err) {
        log("warn", "prospect.audit_link_mint_failed", {
          prospectId: input.prospectId,
          error: err instanceof Error ? err.message : "unknown",
        });
      }
    }
    return ok(result);
  } catch (err) {
    return fail(err);
  }
}

/**
 * Kill the link without the ceremony of a revocation (plan 3.4): the audit
 * stays 'published' in the record — nothing was wrong with it — but the
 * token stops resolving now. Revoke remains the "this should not have gone
 * out" path with its mandatory reason.
 */
export async function expireAudit(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ auditId: string }>> {
  const parsed = z.object({ auditId: z.string().uuid() }).safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "Invalid audit id."));
  }
  const input = parsed.data;
  try {
    assertCanWrite(user);
    await sql.begin(async (tx) => {
      const [row] = await tx`
        update prospect_audits set expires_at = now()
        where id = ${input.auditId} and status = 'published'
          and (expires_at is null or expires_at > now())
        returning id, prospect_id
      `;
      if (!row) {
        throw new ClassifiedError("conflict", "Audit not found, not published, or already expired.");
      }
      await writeAudit(tx, {
        userId: user.id,
        action: "prospect.audit_expire",
        entity: "prospect_audit",
        entityId: input.auditId,
      });
      await logActivity(
        tx,
        row.prospectId as string,
        "audit_expired",
        { auditId: input.auditId },
        user.id
      );
    });
    return ok({ auditId: input.auditId });
  } catch (err) {
    return fail(err);
  }
}

export async function revokeAudit(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ auditId: string }>> {
  const parsed = z
    .object({ auditId: z.string().uuid(), reason: z.string().trim().min(1).max(1000) })
    .safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "A revocation needs a reason."));
  }
  const input = parsed.data;
  try {
    assertCanWrite(user);
    await sql.begin(async (tx) => {
      const [row] = await tx`
        update prospect_audits set
          status = 'revoked', revoked_by = ${user.id}, revoked_at = now(),
          revoke_reason = ${input.reason}
        where id = ${input.auditId} and status = 'published'
        returning id, prospect_id
      `;
      if (!row) {
        throw new ClassifiedError("conflict", "Audit not found or not published.");
      }
      // Burn-the-link burns EVERY door (spec 076): the branded key must die
      // with the token, and a later republish must not resurrect it.
      await revokeAuditLinks(tx, row.prospectId as string);
      await revokeReportSessions(tx, row.prospectId as string);
      await writeAudit(tx, {
        userId: user.id,
        action: "prospect.audit_revoke",
        entity: "prospect_audit",
        entityId: input.auditId,
        detail: { reason: input.reason },
      });
      await logActivity(
        tx,
        row.prospectId as string,
        "audit_revoked",
        { auditId: input.auditId },
        user.id
      );
    });
    return ok({ auditId: input.auditId });
  } catch (err) {
    return fail(err);
  }
}

/**
 * Public token resolution — the ONLY unauthenticated read in this module.
 * Published ∧ unrevoked ∧ unexpired, else null; the page 404s so wrong
 * tokens, revoked tokens, and nonexistent tokens are indistinguishable.
 * Every hit is recorded (insert-only) and surfaces on the timeline.
 */
export interface AuditViewMeta {
  ip?: string | null;
  userAgent?: string | null;
  internal?: boolean;
  /** Branded-link key the visit arrived through (spec 076) — attribution
   * evidence stamped on the view row at insert. */
  linkKey?: string | null;
  referrer?: string | null;
  /** Authorized report session that rendered the page (spec 134) — the
   * unit external-view metrics count by. */
  sessionId?: string | null;
}

export async function getAuditByToken(
  token: string,
  meta: AuditViewMeta = {}
): Promise<AuditSnapshot | null> {
  const page = await getAuditPageByToken(token, meta);
  return page?.snapshot ?? null;
}

/** Same as getAuditByToken, plus the id of the view row just recorded — the
 * handle the page's engagement beacon reports against. */
export async function getAuditPageByToken(
  token: string,
  meta: AuditViewMeta = {}
): Promise<{ snapshot: AuditSnapshot; viewId: string } | null> {
  if (!token || token.length < 20 || token.length > 100) return null;
  return recordAndServe(sql`access_token = ${token}`, meta);
}

/** The clean route's path (spec 134): the report session names the audit
 * id, so the access token is never loaded, rendered or serialized. Same
 * published/unexpired rule, same view row. */
export async function getAuditPageById(
  auditId: string,
  meta: AuditViewMeta = {}
): Promise<{ snapshot: AuditSnapshot; viewId: string } | null> {
  return recordAndServe(sql`id = ${auditId}`, meta);
}

async function recordAndServe(
  where: ReturnType<typeof sql>,
  meta: AuditViewMeta
): Promise<{ snapshot: AuditSnapshot; viewId: string } | null> {
  const rows = await sql`
    select id, prospect_id, snapshot from prospect_audits
    where ${where} and status = 'published'
      and (expires_at is null or expires_at > now())
  `;
  const row = rows[0];
  if (!row) return null;
  // internal = a signed-in staff session opened it (plan 3.6) OR the view
  // came from a declared operator IP (INTERNAL_VIEW_IPS, comma-separated) —
  // logged-out and incognito opens from the operator's own machines must
  // not read as prospect interest either.
  const operatorIps = (process.env.INTERNAL_VIEW_IPS ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  const internal =
    (meta.internal ?? false) || (meta.ip != null && operatorIps.includes(meta.ip));
  const viewId = await sql.begin(async (tx) => {
    const [view] = await tx`
      insert into prospect_audit_views (audit_id, ip, user_agent, is_internal, link_key, referrer, session_id)
      values (${row.id}, ${meta.ip ?? null}, ${meta.userAgent ?? null},
        ${internal}, ${meta.linkKey ?? null}, ${meta.referrer?.slice(0, 500) ?? null}, ${meta.sessionId ?? null})
      returning id
    `;
    if (!internal) {
      await logActivity(tx, row.prospectId as string, "audit_viewed", { auditId: row.id }, null);
    }
    return view?.id as string;
  });
  return { snapshot: row.snapshot as AuditSnapshot, viewId };
}
