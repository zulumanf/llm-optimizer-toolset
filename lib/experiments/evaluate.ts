/**
 * Intervention outcome evaluation (spec 151 B5), pure.
 *
 * Estimators, chosen by what the pre-registered plan made available:
 *   control prompts  → DiD: Δ(entity, treated prompts) − Δ(entity, control prompts)
 *   control entities → DiD: Δ(entity, treated prompts) − Δ(controls, treated prompts)
 *   neither          → paired before/after on the treated prompts (descriptive)
 *
 * Answer scope: all valid answers on the instrument, as in `scores` (echo
 * answers are NOT excluded here; plans should name unbranded target and
 * control prompts). Verdict "no_detectable_change" is an equivalence claim:
 * the interval lies entirely within ±MDE.
 * Every Δ is a paired, prompt-level difference; intervals are prompt-
 * clustered bootstraps (lib/stats). Nothing here makes a design causal — the
 * evidence tier says how much the design supports, and the verdict never
 * says "caused".
 *
 * Evidence tiers:
 *   1 descriptive before/after
 *   2 matched comparison (controls, but not pre-registered before shipping)
 *   3 pre-registered controlled analysis
 *   4 staggered / randomized rollout (declared design + pre-registration + controls)
 */
import {
  differenceInDifferences,
  intervalExcludesZero,
  pairClusters,
  pairedDifference,
  seedFromKey,
  type Cluster,
  type Interval,
} from "@/lib/stats";

export const EXPERIMENT_EVALUATOR_VERSION = "experiment-evaluator-v1";

export type Verdict =
  | "improvement_observed"
  | "no_detectable_change"
  | "negative_change_observed"
  | "inconclusive"
  | "not_comparable";

export type Estimator = "did_control_prompts" | "did_control_entities" | "paired_before_after";

/** One answer, reduced to what evaluation needs. */
export interface Observation {
  promptId: string;
  companyId: string;
  /** The entity scored the primary metric on this answer. */
  hit: boolean;
}

/** All answers of a measurement wave, for one instrument. */
export interface Wave {
  runId: string;
  startedAt: Date;
  instrumentKey: string;
  servedModels: string[];
  /** Every valid answer's prompt id (denominators include non-mentions). */
  answers: { promptId: string; responseId: string }[];
  /** Hits by (responseId, companyId). */
  hits: Set<string>;
}

export interface PlanInput {
  planId: string;
  entityCompanyId: string;
  instrumentKey: string;
  expectedDirection: "increase" | "decrease";
  mde: number | null;
  design: "descriptive" | "matched_comparison" | "preregistered_controlled" | "staggered";
  targetPromptIds: string[];
  controlPromptIds: string[];
  controlCompanyIds: string[];
  approvedAt: Date | null;
  shippedAt: Date | null;
  estimatedCostUsd: number | null;
  knownConfounders: string[];
}

export interface Evaluation {
  evaluatorVersion: string;
  verdict: Verdict;
  estimator: Estimator | null;
  estimate: number | null;
  interval: Interval | null;
  evidenceTier: 1 | 2 | 3 | 4;
  comparability: "comparable" | "not_comparable";
  comparabilityReasons: string[];
  baselineWaves: number;
  postWaves: number;
  promptsCompared: number;
  answersBefore: number;
  answersAfter: number;
  confounders: string[];
  costUsd: number | null;
  explanation: string;
}

function clustersFor(waves: Wave[], companyIds: string[], promptFilter: (id: string) => boolean): Map<string, Cluster> {
  const out = new Map<string, Cluster>();
  for (const w of waves) {
    for (const a of w.answers) {
      if (!promptFilter(a.promptId)) continue;
      for (const companyId of companyIds) {
        const c = out.get(a.promptId) ?? { k: 0, n: 0 };
        c.n += 1;
        if (w.hits.has(`${a.responseId}|${companyId}`)) c.k += 1;
        out.set(a.promptId, c);
      }
    }
  }
  return out;
}

const DAY_MS = 24 * 3600 * 1000;
/** Baseline waves closer together than this are one wave (noise estimate). */
export const MIN_BASELINE_SEPARATION_DAYS = 6;

export function evaluateExperiment(plan: PlanInput, baseline: Wave[], post: Wave[]): Evaluation {
  const reasons: string[] = [];
  const confounders = [...plan.knownConfounders];
  const base = baseline.filter((w) => w.instrumentKey === plan.instrumentKey);
  const after = post.filter((w) => w.instrumentKey === plan.instrumentKey);
  if (base.length === 0) reasons.push("no baseline wave on the pre-registered instrument");
  if (after.length === 0) reasons.push("no post wave on the pre-registered instrument");
  const servedBefore = new Set(base.flatMap((w) => w.servedModels));
  const servedAfter = new Set(after.flatMap((w) => w.servedModels));
  const sameServed =
    servedBefore.size === servedAfter.size && [...servedAfter].every((m) => servedBefore.has(m));
  if (servedBefore.size > 0 && servedAfter.size > 0 && !sameServed) {
    reasons.push(`served model changed (${[...servedBefore].join(", ")} → ${[...servedAfter].join(", ")})`);
  }
  const sortedBase = [...base].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  const separated =
    sortedBase.length >= 2 &&
    (sortedBase.at(-1)!.startedAt.getTime() - sortedBase[0]!.startedAt.getTime()) / DAY_MS >= MIN_BASELINE_SEPARATION_DAYS;
  if (!separated) confounders.push("single baseline wave: run-to-run noise is not estimated");
  if (plan.shippedAt && after.some((w) => w.startedAt.getTime() < plan.shippedAt!.getTime())) {
    reasons.push("a post wave started before the change shipped");
  }
  // shipped_at has day precision: a baseline from the ship day onward may
  // already include the change.
  if (plan.shippedAt && base.some((w) => w.startedAt.getTime() >= plan.shippedAt!.getTime())) {
    reasons.push("a baseline wave started on or after the ship date");
  }

  // shipped_at has day precision: approval any time on the ship day counts.
  const preregistered =
    plan.approvedAt !== null && (plan.shippedAt === null || plan.approvedAt.getTime() < plan.shippedAt.getTime() + DAY_MS);
  if (!preregistered) confounders.push("plan was not approved before the change shipped (not pre-registered)");
  const hasControlPrompts = plan.controlPromptIds.length > 0;
  const hasControlEntities = plan.controlCompanyIds.length > 0;
  const tier: Evaluation["evidenceTier"] =
    !hasControlPrompts && !hasControlEntities
      ? 1
      : !preregistered
        ? 2
        : plan.design === "staggered"
          ? 4
          : 3;

  const base0: Omit<Evaluation, "verdict" | "estimator" | "estimate" | "interval" | "promptsCompared" | "answersBefore" | "answersAfter" | "explanation"> = {
    evaluatorVersion: EXPERIMENT_EVALUATOR_VERSION,
    evidenceTier: tier,
    comparability: reasons.length > 0 ? "not_comparable" : "comparable",
    comparabilityReasons: reasons,
    baselineWaves: base.length,
    postWaves: after.length,
    confounders,
    costUsd: plan.estimatedCostUsd,
  };
  if (reasons.length > 0) {
    return { ...base0, verdict: "not_comparable", estimator: null, estimate: null, interval: null, promptsCompared: 0, answersBefore: 0, answersAfter: 0, explanation: `Not comparable: ${reasons.join("; ")}.` };
  }

  const controlSet = new Set(plan.controlPromptIds);
  const targetSet = new Set(plan.targetPromptIds);
  const isTreated = (id: string) => (targetSet.size > 0 ? targetSet.has(id) : !controlSet.has(id));
  const treated = pairClusters(
    clustersFor(base, [plan.entityCompanyId], isTreated),
    clustersFor(after, [plan.entityCompanyId], isTreated)
  );
  const seed = seedFromKey(`${plan.planId}|${after.map((w) => w.runId).sort().join(",")}`);

  let estimator: Estimator;
  let estimate: number | null;
  let interval: Interval | null;
  if (hasControlPrompts) {
    const control = pairClusters(
      clustersFor(base, [plan.entityCompanyId], (id) => controlSet.has(id)),
      clustersFor(after, [plan.entityCompanyId], (id) => controlSet.has(id))
    );
    const did = differenceInDifferences(treated, control, seed);
    estimator = "did_control_prompts";
    ({ estimate, interval } = did);
  } else if (hasControlEntities) {
    const control = pairClusters(
      clustersFor(base, plan.controlCompanyIds, isTreated),
      clustersFor(after, plan.controlCompanyIds, isTreated)
    );
    const did = differenceInDifferences(treated, control, seed);
    estimator = "did_control_entities";
    ({ estimate, interval } = did);
  } else {
    const diff = pairedDifference(treated, seed);
    estimator = "paired_before_after";
    ({ estimate, interval } = diff);
  }

  const answersBefore = treated.reduce((a, p) => a + p.before.n, 0);
  const answersAfter = treated.reduce((a, p) => a + p.after.n, 0);
  const signed = (v: number) => (plan.expectedDirection === "increase" ? v : -v);
  let verdict: Verdict;
  if (estimate === null || interval === null) {
    verdict = "inconclusive";
  } else if (intervalExcludesZero(interval)) {
    verdict = signed(estimate) > 0 ? "improvement_observed" : "negative_change_observed";
  } else if (plan.mde !== null && interval[0] > -plan.mde && interval[1] < plan.mde) {
    // Equivalence: the whole interval lies inside ±MDE, so any effect at
    // least the pre-registered size is ruled out (review finding M1).
    verdict = "no_detectable_change";
  } else {
    verdict = "inconclusive";
  }

  const pctText = (v: number) => `${(v * 100).toFixed(1)} pts`;
  const explanation =
    estimate === null || interval === null
      ? `Too few paired prompts (${treated.length}) for an interval; no conclusion.`
      : `Estimated change ${pctText(estimate)} (95% interval ${pctText(interval[0])} to ${pctText(interval[1])}) over ${treated.length} paired prompts, by ${estimator.replaceAll("_", " ")}. ` +
        `Evidence tier ${tier}. An association under this design, not proof of cause.`;
  return { ...base0, verdict, estimator, estimate, interval, promptsCompared: treated.length, answersBefore, answersAfter, explanation };
}

/** Cross-client learning (spec 151 B6): descriptive counts only. */
export interface LearningRow {
  interventionType: string;
  instrumentKey: string;
  evidenceTier: number;
  verdict: Verdict;
  estimate: number | null;
}

export interface LearningSummary {
  interventionType: string;
  instrumentKey: string;
  evidenceTier: number;
  evaluations: number;
  verdicts: Record<Verdict, number>;
  medianEstimate: number | null;
}

/** Below this many evaluations a group is listed, never summarized as a rate. */
export const MIN_EVALUATIONS_FOR_SUMMARY = 5;

export function summarizeLearning(rows: LearningRow[]): LearningSummary[] {
  const groups = new Map<string, LearningRow[]>();
  for (const r of rows) {
    const key = `${r.interventionType}|${r.instrumentKey}|${r.evidenceTier}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.values()].map((list) => {
    const verdicts: Record<Verdict, number> = {
      improvement_observed: 0,
      no_detectable_change: 0,
      negative_change_observed: 0,
      inconclusive: 0,
      not_comparable: 0,
    };
    for (const r of list) verdicts[r.verdict] += 1;
    const estimates = list.map((r) => r.estimate).filter((e): e is number => e !== null).sort((a, b) => a - b);
    const mid = Math.floor(estimates.length / 2);
    const median =
      list.length < MIN_EVALUATIONS_FOR_SUMMARY || estimates.length === 0
        ? null
        : estimates.length % 2
          ? (estimates[mid] as number)
          : ((estimates[mid - 1] as number) + (estimates[mid] as number)) / 2;
    const first = list[0]!;
    return {
      interventionType: first.interventionType,
      instrumentKey: first.instrumentKey,
      evidenceTier: first.evidenceTier,
      evaluations: list.length,
      verdicts,
      medianEstimate: median,
    };
  }).sort((a, b) => b.evaluations - a.evaluations || a.interventionType.localeCompare(b.interventionType));
}
