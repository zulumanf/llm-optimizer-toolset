/**
 * Competitive-mismatch eligibility (spec 124). Deterministic, fail-closed:
 * the template may claim "a lower-producing rival is recommended more often
 * by OpenAI's models" ONLY when every leg of the comparison is clean — same
 * market (same launch by construction), same RealTrends production year,
 * same metric, same entity type, verified sources, an OpenAI-only answer
 * denominator, and a fresh benchmark. Anything less returns reason codes
 * and the caller falls back to the reply-first template. Pure evaluation
 * core + a DB assembler; no LLM anywhere.
 */
import { sql } from "@/db/client";
import type { TransactionSql } from "@/db/client";
import { getPrimaryFinding, launchMarketName } from "@/lib/prospects/shared";
import {
  providerRecommendationCounts,
  runSummary,
  type ProviderRecommendationCounts,
} from "@/lib/prospects/benchmark";
import {
  latestVerifiedProductionByProspect,
  type ProductionEvidence,
} from "@/lib/prospects/realtrends";
import { MISMATCH_TEMPLATE_VERSION, MISMATCH_THRESHOLDS } from "@/lib/prospects/constants";
import { OPERATOR_TIMEZONE } from "@/lib/prospects/intent";

/** The provider whose answers this template counts. Never widened to a
 * mixed-provider total — the email names the consumer counterpart. */
export const MISMATCH_PROVIDER = "openai";

export type MismatchReasonCode =
  | "NO_BENCHMARK"
  | "NO_VALID_COMPETITOR"
  | "NO_LOWER_PRODUCING_COMPETITOR"
  | "NO_HIGHER_RECOMMENDATION_COMPETITOR"
  | "PRODUCTION_PERIOD_MISMATCH"
  | "PRODUCTION_METRIC_MISMATCH"
  | "ENTITY_LEVEL_MISMATCH"
  | "PRODUCTION_DATA_UNVERIFIED"
  | "RECOMMENDATION_GAP_TOO_SMALL"
  | "PRODUCTION_GAP_TOO_SMALL"
  | "BENCHMARK_TOO_OLD"
  | "BENCHMARK_SCOPE_INVALID"
  | "CHATGPT_DATA_UNAVAILABLE"
  | "ENTITY_RESOLUTION_UNCERTAIN"
  | "NO_RECIPIENT_FIRST_NAME";

export type MismatchMetricType = "closed_volume" | "sides";

/** Operator-readable explanation per reason code. */
export const MISMATCH_REASON_LABELS: Record<MismatchReasonCode, string> = {
  NO_BENCHMARK: "No approved story is bound to a benchmark run yet.",
  NO_VALID_COMPETITOR:
    "No same-market team with verified RealTrends production to compare against.",
  NO_LOWER_PRODUCING_COMPETITOR:
    "Every comparable competitor produces at least as much as this team.",
  NO_HIGHER_RECOMMENDATION_COMPETITOR:
    "No comparable competitor is recommended more often in the OpenAI answers.",
  PRODUCTION_PERIOD_MISMATCH: "Production figures come from different years.",
  PRODUCTION_METRIC_MISMATCH:
    "The two sides do not report the same production metric.",
  ENTITY_LEVEL_MISMATCH:
    "The comparison would cross entity levels (team vs individual).",
  PRODUCTION_DATA_UNVERIFIED:
    "Verified RealTrends production (with its year) is missing.",
  RECOMMENDATION_GAP_TOO_SMALL: `The recommendation gap is under the minimum of +${MISMATCH_THRESHOLDS.minRecommendationGap}.`,
  PRODUCTION_GAP_TOO_SMALL: `The competitor produces more than ${Math.round(MISMATCH_THRESHOLDS.maxCompetitorProductionRatio * 100)}% of this team — not a clean inversion.`,
  BENCHMARK_TOO_OLD: `The benchmark is older than the ${MISMATCH_THRESHOLDS.maxBenchmarkAgeDays}-day maximum — refresh it first.`,
  BENCHMARK_SCOPE_INVALID: "The benchmark run has no completed capture.",
  CHATGPT_DATA_UNAVAILABLE: "The benchmark contains no OpenAI answers.",
  ENTITY_RESOLUTION_UNCERTAIN:
    "The prospect is not confidently linked to a tracked company.",
  NO_RECIPIENT_FIRST_NAME: "No recipient first name is on file.",
};

export interface MismatchEntityInput {
  companyId: string;
  prospectId: string;
  displayName: string;
  production: ProductionEvidence | null;
  /** OpenAI-only, echo-excluded recommendation count (canonical service). */
  recommendationCount: number;
}

export interface MismatchCandidate extends MismatchEntityInput {
  /** Empty = eligible against this prospect. */
  reasonCodes: MismatchReasonCode[];
  metricType: MismatchMetricType | null;
  /** competitor production / prospect production, on the shared metric. */
  productionRatio: number | null;
  recommendationGap: number;
}

export interface MismatchEvaluationInput {
  now: Date;
  firstName: string | null;
  prospect: {
    companyId: string | null;
    production: ProductionEvidence | null;
    recommendationCount: number;
  };
  candidates: MismatchEntityInput[];
  benchmark: { answerCount: number; completedAt: Date | null };
}

export interface MismatchEvaluation {
  eligible: boolean;
  reasonCodes: MismatchReasonCode[];
  /** Best eligible candidate (largest recommendation gap, then strongest
   * production inversion, then name) — the default competitor. */
  selected: MismatchCandidate | null;
  eligibleCandidates: MismatchCandidate[];
  candidates: MismatchCandidate[];
  benchmarkAgeDays: number | null;
}

// ---------------------------------------------------------------- pure core

const dedupe = <T>(xs: T[]): T[] => [...new Set(xs)];

/** Shared metric for a pair: closed volume when both sides report it, else
 * sides when both report that; volume and sides never compare. */
export function sharedMetric(
  a: ProductionEvidence,
  b: ProductionEvidence
): MismatchMetricType | null {
  if (a.volumeUsd > 0 && b.volumeUsd > 0) return "closed_volume";
  if (a.sides > 0 && b.sides > 0) return "sides";
  return null;
}

function metricValue(p: ProductionEvidence, metric: MismatchMetricType): number {
  return metric === "closed_volume" ? p.volumeUsd : p.sides;
}

export function evaluateCandidate(
  prospect: { production: ProductionEvidence; recommendationCount: number },
  candidate: MismatchEntityInput
): MismatchCandidate {
  const codes: MismatchReasonCode[] = [];
  let metricType: MismatchMetricType | null = null;
  let ratio: number | null = null;
  const gap = candidate.recommendationCount - prospect.recommendationCount;
  const c = candidate.production;
  if (!c || !c.sourceUrl) {
    codes.push("PRODUCTION_DATA_UNVERIFIED");
  } else {
    if (!c.entityType || !prospect.production.entityType) {
      codes.push("ENTITY_LEVEL_MISMATCH");
    } else if (c.entityType !== prospect.production.entityType) {
      codes.push("ENTITY_LEVEL_MISMATCH");
    }
    if (
      c.productionYear === null ||
      prospect.production.productionYear === null ||
      c.productionYear !== prospect.production.productionYear
    ) {
      codes.push("PRODUCTION_PERIOD_MISMATCH");
    }
    metricType = sharedMetric(prospect.production, c);
    if (metricType === null) {
      codes.push("PRODUCTION_METRIC_MISMATCH");
    } else {
      const pv = metricValue(prospect.production, metricType);
      const cv = metricValue(c, metricType);
      ratio = pv > 0 ? cv / pv : null;
      if (cv >= pv) {
        codes.push("NO_LOWER_PRODUCING_COMPETITOR");
      } else if (ratio !== null && ratio > MISMATCH_THRESHOLDS.maxCompetitorProductionRatio) {
        codes.push("PRODUCTION_GAP_TOO_SMALL");
      }
    }
  }
  if (gap <= 0) {
    codes.push("NO_HIGHER_RECOMMENDATION_COMPETITOR");
  } else if (gap < MISMATCH_THRESHOLDS.minRecommendationGap) {
    codes.push("RECOMMENDATION_GAP_TOO_SMALL");
  }
  return {
    ...candidate,
    reasonCodes: codes,
    metricType,
    productionRatio: ratio,
    recommendationGap: gap,
  };
}

export function evaluateMismatch(input: MismatchEvaluationInput): MismatchEvaluation {
  const ageDays =
    input.benchmark.completedAt === null
      ? null
      : Math.floor(
          (input.now.getTime() - input.benchmark.completedAt.getTime()) / 86_400_000
        );
  const globals: MismatchReasonCode[] = [];
  if (!input.firstName) globals.push("NO_RECIPIENT_FIRST_NAME");
  if (!input.prospect.companyId) globals.push("ENTITY_RESOLUTION_UNCERTAIN");
  if (input.benchmark.completedAt === null) globals.push("BENCHMARK_SCOPE_INVALID");
  else if (ageDays !== null && ageDays > MISMATCH_THRESHOLDS.maxBenchmarkAgeDays) {
    globals.push("BENCHMARK_TOO_OLD");
  }
  if (input.benchmark.answerCount <= 0) globals.push("CHATGPT_DATA_UNAVAILABLE");
  if (!input.prospect.production || !input.prospect.production.productionYear) {
    globals.push("PRODUCTION_DATA_UNVERIFIED");
  }

  const prospectProduction = input.prospect.production;
  const candidates =
    prospectProduction === null
      ? input.candidates.map((c) => ({
          ...c,
          reasonCodes: ["PRODUCTION_DATA_UNVERIFIED" as MismatchReasonCode],
          metricType: null,
          productionRatio: null,
          recommendationGap: c.recommendationCount - input.prospect.recommendationCount,
        }))
      : input.candidates.map((c) =>
          evaluateCandidate(
            {
              production: prospectProduction,
              recommendationCount: input.prospect.recommendationCount,
            },
            c
          )
        );
  const eligibleCandidates = candidates
    .filter((c) => c.reasonCodes.length === 0)
    .sort(
      (a, b) =>
        b.recommendationGap - a.recommendationGap ||
        (a.productionRatio ?? 1) - (b.productionRatio ?? 1) ||
        a.displayName.localeCompare(b.displayName)
    );

  let reasonCodes = globals;
  if (globals.length === 0 && eligibleCandidates.length === 0) {
    reasonCodes =
      input.candidates.length === 0
        ? ["NO_VALID_COMPETITOR"]
        : dedupe(candidates.flatMap((c) => c.reasonCodes));
  }
  const eligible = globals.length === 0 && eligibleCandidates.length > 0;
  return {
    eligible,
    reasonCodes: eligible ? [] : reasonCodes,
    selected: eligibleCandidates[0] ?? null,
    eligibleCandidates,
    candidates,
    benchmarkAgeDays: ageDays,
  };
}

// ----------------------------------------------------------- copy helpers

/** "Jersey City, NJ" → "Jersey City" — the subject-line market. */
export function marketShortName(marketName: string): string {
  return marketName.split(",")[0]!.trim();
}

/** Deterministic scope description from the run's frozen prompt audiences —
 * never a hardcoded "sellers asking who to hire" the data can't support. */
export function benchmarkScopeCopy(marketName: string, audiences: string[]): string {
  const set = new Set(audiences.filter((a) => a === "buyer" || a === "seller"));
  const market = marketShortName(marketName);
  if (set.size === 1 && set.has("seller") && audiences.every((a) => a === "seller")) {
    return `questions ${market} sellers ask when choosing an agent`;
  }
  if (set.has("buyer") && set.has("seller")) {
    return `${market} buyer and seller questions`;
  }
  return `${market} real estate questions`;
}

/** Scope-matched implication. Never an observed-loss claim. */
export function implicationLine(audiences: string[]): string {
  const sellerOnly =
    audiences.length > 0 && audiences.every((a) => a === "seller");
  return sellerOnly
    ? "When someone asks who to call, they can see them first."
    : "When people use ChatGPT to research who to work with, they can see them before they see you.";
}

/** Monday-start week index of a date in the operator's timezone. */
function operatorWeekIndex(d: Date): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: OPERATOR_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
  const [y, m, day] = parts.split("-").map(Number);
  const dayNumber = Math.floor(Date.UTC(y!, m! - 1, day!) / 86_400_000);
  return Math.floor((dayNumber + 3) / 7);
}

/** Truthful recency wording — never a hardcoded "Last week". */
export function recencyPhrase(capturedAt: Date, now: Date): string {
  const diff = operatorWeekIndex(now) - operatorWeekIndex(capturedAt);
  if (diff <= 0) return "Earlier this week";
  if (diff === 1) return "Last week";
  return "Recently";
}

/** "$47.2M closed" / "$125M closed" / "83 closed sides" — no false
 * precision, matching RealTrends' own units. */
export function formatProductionDisplay(
  metricType: MismatchMetricType,
  value: number
): string {
  if (metricType === "sides") return `${value} closed sides`;
  const millions = value / 1_000_000;
  const text =
    millions >= 100 ? String(Math.round(millions)) : millions.toFixed(1).replace(/\.0$/, "");
  return `$${text}M closed`;
}

export const PRODUCTION_METRIC_COPY: Record<MismatchMetricType, string> = {
  closed_volume: "closed volume",
  sides: "closed sides",
};

// -------------------------------------------------------- evidence snapshot

/** What a mismatch draft asserts, frozen onto the draft row so the sent
 * claim is auditable later even as newer data arrives (spec 124). */
export interface MismatchEvidenceSnapshot {
  templateVersion: string;
  runId: string;
  provider: string;
  answerCount: number;
  modelCount: number;
  capturedAt: string | null;
  completedAt: string | null;
  scopeCopy: string;
  audiences: string[];
  prospect: MismatchSnapshotEntity;
  competitor: MismatchSnapshotEntity & {
    productionRatio: number | null;
    recommendationGap: number;
  };
  metricType: MismatchMetricType;
  thresholds: typeof MISMATCH_THRESHOLDS;
}

interface MismatchSnapshotEntity {
  companyId: string;
  prospectId: string;
  name: string;
  recommendationCount: number;
  productionSignalId: string;
  productionSourceUrl: string;
  productionYear: number | null;
  productionValue: number;
  productionDisplay: string;
}

// ------------------------------------------------------------- DB assembler

export interface CompetitiveMismatchReview {
  prospectId: string;
  runId: string | null;
  marketName: string;
  audiences: string[];
  scopeCopy: string;
  benchmark: ProviderRecommendationCounts | null;
  benchmarkCompletedAt: Date | null;
  firstName: string | null;
  prospect: {
    companyId: string | null;
    displayName: string;
    production: ProductionEvidence | null;
    recommendationCount: number;
  };
  evaluation: MismatchEvaluation;
}

/**
 * Assemble the full mismatch picture for one prospect: candidates are the
 * OTHER unarchived non-brokerage prospects of the same market launch (same
 * market by construction, and the only entities with verified RealTrends
 * production on file). Used by draft generation, the operator panel, draft
 * QA revalidation, and the backfill script — one source, no recomputation.
 */
export async function competitiveMismatchReview(
  prospectId: string,
  opts: { contactId?: string | null; db?: TransactionSql | typeof sql; now?: Date } = {}
): Promise<CompetitiveMismatchReview | null> {
  const db = opts.db ?? sql;
  const now = opts.now ?? new Date();
  const [p] = await db`
    select id, company_id, business_name, team_leader, launch_id, prospect_type
    from prospects where id = ${prospectId} and archived_at is null
  `;
  if (!p) return null;
  const marketName = await launchMarketName(db, p.launchId as string);

  let contactName: string | null = null;
  if (opts.contactId) {
    const [c] = await db`
      select name from prospect_contacts
      where id = ${opts.contactId} and prospect_id = ${prospectId}
    `;
    contactName = (c?.name as string | undefined) ?? null;
  } else {
    // No explicit recipient: the primary contact is who a generated draft
    // would default to, so eligibility previews against that person.
    const [c] = await db`
      select name from prospect_contacts
      where prospect_id = ${prospectId} and is_primary
        and not do_not_contact and archived_at is null
    `;
    contactName = (c?.name as string | undefined) ?? null;
  }
  const firstName =
    (contactName ?? (p.teamLeader as string | null))?.trim().split(/\s+/)[0] ?? null;

  const ineligible = (
    codes: MismatchReasonCode[],
    extra: Partial<CompetitiveMismatchReview> = {}
  ): CompetitiveMismatchReview => ({
    prospectId,
    runId: null,
    marketName,
    audiences: [],
    scopeCopy: benchmarkScopeCopy(marketName, []),
    benchmark: null,
    benchmarkCompletedAt: null,
    firstName,
    prospect: {
      companyId: (p.companyId as string | null) ?? null,
      displayName: p.businessName as string,
      production: null,
      recommendationCount: 0,
    },
    evaluation: {
      eligible: false,
      reasonCodes: codes,
      selected: null,
      eligibleCandidates: [],
      candidates: [],
      benchmarkAgeDays: null,
    },
    ...extra,
  });

  let runId: string | null = null;
  try {
    const finding = await getPrimaryFinding(db, prospectId);
    const [benchmark] = await db`
      select run_id from prospect_benchmarks where id = ${finding.benchmarkId}
    `;
    runId = (benchmark?.runId as string | undefined) ?? null;
  } catch {
    runId = null;
  }
  if (!runId) return ineligible(["NO_BENCHMARK"]);

  const run = await runSummary(runId);
  if (!run) return ineligible(["NO_BENCHMARK"]);

  const audienceRows = await db`
    select distinct p.audience
    from runs r
    join prompt_set_versions v on v.id = r.prompt_set_version_id,
    jsonb_to_recordset(v.frozen_prompts)
      as p(audience text, "isHoldout" boolean)
    where r.id = ${runId} and not coalesce(p."isHoldout", false)
      and p.audience is not null
  `;
  const audiences = audienceRows.map((r) => r.audience as string);

  const peers = await db`
    select id, company_id, business_name
    from prospects
    where launch_id = ${p.launchId} and id != ${prospectId}
      and archived_at is null and company_id is not null
      and prospect_type != 'brokerage'
  `;
  const production = await latestVerifiedProductionByProspect([
    prospectId,
    ...peers.map((r) => r.id as string),
  ]);
  const companyIds = [
    ...(p.companyId ? [p.companyId as string] : []),
    ...peers.map((r) => r.companyId as string),
  ];
  const counts = await providerRecommendationCounts(
    runId,
    MISMATCH_PROVIDER,
    companyIds
  );

  const prospect = {
    companyId: (p.companyId as string | null) ?? null,
    production: production.get(prospectId) ?? null,
    recommendationCount: p.companyId
      ? (counts.recommendedByCompany[p.companyId as string] ?? 0)
      : 0,
  };
  const candidates: MismatchEntityInput[] = peers.map((r) => ({
    companyId: r.companyId as string,
    prospectId: r.id as string,
    displayName: r.businessName as string,
    production: production.get(r.id as string) ?? null,
    recommendationCount: counts.recommendedByCompany[r.companyId as string] ?? 0,
  }));

  const evaluation = evaluateMismatch({
    now,
    firstName,
    prospect,
    candidates,
    benchmark: { answerCount: counts.answerCount, completedAt: run.completedAt },
  });

  return {
    prospectId,
    runId,
    marketName,
    audiences,
    scopeCopy: benchmarkScopeCopy(marketName, audiences),
    benchmark: counts,
    benchmarkCompletedAt: run.completedAt,
    firstName,
    prospect: { ...prospect, displayName: p.businessName as string },
    evaluation,
  };
}

/** Freeze the facts a draft will assert. Caller guarantees eligibility. */
export function buildEvidenceSnapshot(
  review: CompetitiveMismatchReview,
  competitor: MismatchCandidate
): MismatchEvidenceSnapshot {
  const pp = review.prospect.production!;
  const cp = competitor.production!;
  const metricType = competitor.metricType!;
  const entity = (
    e: { companyId: string; prospectId: string; name: string; recommendationCount: number },
    prod: ProductionEvidence
  ): MismatchSnapshotEntity => ({
    ...e,
    productionSignalId: prod.signalId,
    productionSourceUrl: prod.sourceUrl,
    productionYear: prod.productionYear,
    productionValue: metricType === "closed_volume" ? prod.volumeUsd : prod.sides,
    productionDisplay: formatProductionDisplay(
      metricType,
      metricType === "closed_volume" ? prod.volumeUsd : prod.sides
    ),
  });
  return {
    templateVersion: MISMATCH_TEMPLATE_VERSION,
    runId: review.runId!,
    provider: MISMATCH_PROVIDER,
    answerCount: review.benchmark!.answerCount,
    modelCount: review.benchmark!.modelCount,
    capturedAt: review.benchmark!.capturedAt?.toISOString() ?? null,
    completedAt: review.benchmarkCompletedAt?.toISOString() ?? null,
    scopeCopy: review.scopeCopy,
    audiences: review.audiences,
    prospect: entity(
      {
        companyId: review.prospect.companyId!,
        prospectId: review.prospectId,
        name: review.prospect.displayName,
        recommendationCount: review.prospect.recommendationCount,
      },
      pp
    ),
    competitor: {
      ...entity(
        {
          companyId: competitor.companyId,
          prospectId: competitor.prospectId,
          name: competitor.displayName,
          recommendationCount: competitor.recommendationCount,
        },
        cp
      ),
      productionRatio: competitor.productionRatio,
      recommendationGap: competitor.recommendationGap,
    },
    metricType,
    thresholds: MISMATCH_THRESHOLDS,
  };
}
