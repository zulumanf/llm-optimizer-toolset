/**
 * Performance fee rules (spec 152). Pure: no DB, no env — client-safe.
 *
 * A performance fee is owed only when the FOUNDER records the agreed target
 * as met against a remeasurement taken with the same instrument as the frozen
 * target. Nothing here decides "met": `observedPerformance` reports what the
 * remeasurement shows next to the thresholds, and the founder decides.
 */
import { addDays } from "@/lib/engagements/rules";
import type { MeasurementSnapshot } from "@/lib/engagements/rules";

export const PERFORMANCE_OUTCOMES = ["not_applicable", "pending", "met", "not_met"] as const;
export type PerformanceOutcome = (typeof PERFORMANCE_OUTCOMES)[number];
/** The two outcomes a founder may record. */
export const DECIDED_PERFORMANCE_OUTCOMES = ["met", "not_met"] as const;
export type DecidedPerformanceOutcome = (typeof DECIDED_PERFORMANCE_OUTCOMES)[number];

export const PERFORMANCE_METRICS = ["recommendation_rate", "question_coverage"] as const;
export type PerformanceMetric = (typeof PERFORMANCE_METRICS)[number];

export const PERFORMANCE_METRIC_LABELS: Record<PerformanceMetric, string> = {
  recommendation_rate: "Recommendation rate",
  question_coverage: "Question coverage",
};

export const PERFORMANCE_METRIC_DEFINITIONS: Record<PerformanceMetric, string> = {
  recommendation_rate: "the share of valid answers in which the client is recommended",
  question_coverage: "the share of questions in which the client is recommended at least once",
};

/** Founder decision 2026-10-28: 90 days from the frozen baseline to the rerun. */
export const PERFORMANCE_RERUN_DAYS_AFTER_BASELINE = 90;
/** Days after "met" the performance invoice falls due when no policy says otherwise (founder decision 2026-10-28). */
export const DEFAULT_PERFORMANCE_FEE_DUE_DAYS = 14;
/** Deterministic suffix of the performance invoice id: ENG-<id8>-P. */
export const PERFORMANCE_INVOICE_SUFFIX = "P";

const PERCENT = 100;
/** Percentages are stored to one decimal place. */
const PERCENT_DECIMALS = 10;

export interface PerformanceThreshold {
  metric: PerformanceMetric;
  /** The target: at least this percentage at the rerun. */
  thresholdPercent: number;
  /** What the frozen baseline measured, for the record. */
  baselinePercent: number;
}

/** The frozen definition of the agreed target (client_engagements.performance_target). */
export interface PerformanceTarget {
  /** Primary measure — always recommendation rate. */
  primary: PerformanceThreshold;
  /** Optional secondary measure — question coverage. When present, both thresholds must be reached. */
  secondary: PerformanceThreshold | null;
  instrument: {
    promptSetVersionId: string;
    questionCount: number;
    provider: string;
    /** The exact model version(s) the baseline answers came from. */
    models: string[];
    repetitions: number;
    scoringVersion: string;
  };
  /** Name variants counted as the client. */
  entityNames: string[];
  baselineMeasurementId: string;
  baselineFrozenOn: string;
  /** Baseline + PERFORMANCE_RERUN_DAYS_AFTER_BASELINE. */
  rerunOn: string;
  agreedOn: string;
  note: string | null;
}

export function percent(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * PERCENT * PERCENT_DECIMALS) / PERCENT_DECIMALS;
}

/** Recommendation rate and question coverage as one snapshot measured them. */
export function snapshotMetrics(s: MeasurementSnapshot): Record<PerformanceMetric, number> {
  return {
    recommendation_rate: percent(s.subject.recommendedCount, s.answerCount),
    question_coverage: percent(s.subject.distinctQuestions, s.questionCount),
  };
}

export interface PerformanceTargetInput {
  recommendationRatePercent: number;
  questionCoveragePercent?: number | null;
  agreedOn: string;
  note?: string | null;
}

/** Freeze the target over the baseline snapshot: the instrument, the names
 * and the baseline values come from the evidence, never from typing. */
export function buildPerformanceTarget(input: {
  target: PerformanceTargetInput;
  baseline: MeasurementSnapshot;
  baselineMeasurementId: string;
  baselineFrozenOn: string;
}): PerformanceTarget {
  const b = input.baseline;
  const metrics = snapshotMetrics(b);
  const coverage = input.target.questionCoveragePercent;
  return {
    primary: { metric: "recommendation_rate", thresholdPercent: input.target.recommendationRatePercent, baselinePercent: metrics.recommendation_rate },
    secondary:
      coverage === null || coverage === undefined
        ? null
        : { metric: "question_coverage", thresholdPercent: coverage, baselinePercent: metrics.question_coverage },
    instrument: {
      promptSetVersionId: b.promptSetVersionId,
      questionCount: b.questionCount,
      provider: b.provider,
      models: [...b.models].sort(),
      repetitions: b.repetitions,
      scoringVersion: b.versions.scoringVersion,
    },
    entityNames: [...new Set([b.subject.name, ...b.subject.aliases].filter((n) => n.trim().length > 0))],
    baselineMeasurementId: input.baselineMeasurementId,
    baselineFrozenOn: input.baselineFrozenOn,
    rerunOn: addDays(input.baselineFrozenOn, PERFORMANCE_RERUN_DAYS_AFTER_BASELINE),
    agreedOn: input.target.agreedOn,
    note: input.target.note?.trim() || null,
  };
}

/** Every way a remeasurement's instrument differs from the frozen target's.
 * Empty = the identical instrument; anything else refuses an outcome. */
export function instrumentMismatches(target: PerformanceTarget, s: MeasurementSnapshot): string[] {
  const t = target.instrument;
  const out: string[] = [];
  if (s.promptSetVersionId !== t.promptSetVersionId) out.push("question set version differs from the target");
  if (s.questionCount !== t.questionCount) out.push(`question count ${t.questionCount} → ${s.questionCount}`);
  if (s.provider !== t.provider) out.push(`provider ${t.provider} → ${s.provider}`);
  const models = [...s.models].sort();
  if (models.length !== t.models.length || models.some((m, i) => m !== t.models[i])) {
    out.push(`model ${t.models.join(", ")} → ${models.join(", ")}`);
  }
  if (s.repetitions !== t.repetitions) out.push(`repetitions ${t.repetitions} → ${s.repetitions}`);
  if (s.versions.scoringVersion !== t.scoringVersion) out.push(`scoring version ${t.scoringVersion} → ${s.versions.scoringVersion}`);
  return out;
}

export interface ObservedThreshold extends PerformanceThreshold {
  observedPercent: number;
  reached: boolean;
}

/** What the remeasurement shows against each threshold — information for the
 * founder's decision, never the decision itself. */
export function observedPerformance(target: PerformanceTarget, s: MeasurementSnapshot): ObservedThreshold[] {
  const m = snapshotMetrics(s);
  return [target.primary, ...(target.secondary ? [target.secondary] : [])].map((t) => ({
    ...t,
    observedPercent: m[t.metric],
    reached: m[t.metric] >= t.thresholdPercent,
  }));
}

export type PerformanceFeeStatus = "not_applicable" | "pending_target" | "not_owed" | "due" | "paid";

/** The panel line: "Performance fee: pending target / not owed / due $4,000". */
export function performanceFeeStatus(i: { outcome: PerformanceOutcome; feeCents: number; paidCents: number }): PerformanceFeeStatus {
  if (i.outcome === "not_applicable" || i.feeCents <= 0) return "not_applicable";
  if (i.outcome === "pending") return "pending_target";
  if (i.outcome === "not_met") return "not_owed";
  return i.paidCents >= i.feeCents ? "paid" : "due";
}

/** One line per target threshold, for operator views and the agreement. */
export function describeThreshold(t: PerformanceThreshold): string {
  return `${PERFORMANCE_METRIC_LABELS[t.metric]} of at least ${t.thresholdPercent}% (${PERFORMANCE_METRIC_DEFINITIONS[t.metric]}; baseline ${t.baselinePercent}%)`;
}

/** The invoice id of the performance fee. */
export function performanceInvoiceId(engagementId: string): string {
  return `ENG-${engagementId.slice(0, 8).toUpperCase()}-${PERFORMANCE_INVOICE_SUFFIX}`;
}
