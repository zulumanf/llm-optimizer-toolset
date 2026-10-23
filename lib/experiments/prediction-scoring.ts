/**
 * Pure scoring for offline prediction evaluation (release 151). No database
 * access, so it is unit-tested directly; see lib/experiments/predictions.ts.
 */
import type { Verdict } from "@/lib/experiments/evaluate";

export const BASELINE_PREDICTOR = { name: "no-change", version: "no-change-v1" } as const;
export const PRIOR_PREDICTOR = { name: "descriptive-prior", version: "descriptive-prior-v1" } as const;
/** Minimum real, comparable past evaluations before a prior may predict. */
export const MIN_PRIOR_EVALUATIONS = 5;
/** Minimum scored pairs before any aggregate metric is reported. */
export const MIN_SCORED_PAIRS = 10;
const BASELINE_HALF_WIDTH = 0.1;

export interface PredictionInput {
  predictedChange: number;
  predictedLow: number;
  predictedHigh: number;
  probabilityImprovement: number;
}

export interface Outcome {
  verdict: Verdict;
  estimate: number | null;
  comparable: boolean;
  synthetic: boolean;
  /** Prediction recorded strictly before the change shipped. */
  recordedBeforeShipping: boolean;
}

export type Eligibility = "scored" | "not_comparable" | "no_estimate" | "synthetic" | "late" | "pending";

export function eligibility(o: Outcome | null): Eligibility {
  if (!o) return "pending";
  if (o.synthetic) return "synthetic";
  if (!o.recordedBeforeShipping) return "late";
  if (!o.comparable || o.verdict === "not_comparable") return "not_comparable";
  if (o.estimate === null) return "no_estimate";
  return "scored";
}

export interface PairScore {
  absoluteError: number;
  covered: boolean;
  directionAgrees: boolean | null;
  brier: number;
}

/** Per-pair proper scores. `improvement` = the evaluator reported
 * improvement_observed (the thing the probability is about). */
export function scorePair(p: PredictionInput, o: Outcome & { estimate: number }): PairScore {
  const improvement = o.verdict === "improvement_observed" ? 1 : 0;
  const sign = (v: number) => (Math.abs(v) < 1e-9 ? 0 : Math.sign(v));
  return {
    absoluteError: Math.abs(p.predictedChange - o.estimate),
    covered: o.estimate >= p.predictedLow && o.estimate <= p.predictedHigh,
    directionAgrees: sign(p.predictedChange) === 0 || sign(o.estimate) === 0 ? null : sign(p.predictedChange) === sign(o.estimate),
    brier: (p.probabilityImprovement - improvement) ** 2,
  };
}

export interface PredictorReport {
  predictor: string;
  predictorVersion: string;
  counts: Record<Eligibility, number>;
  scoredPairs: number;
  /** Null below MIN_SCORED_PAIRS: too few to say anything. */
  meanAbsoluteError: number | null;
  intervalCoverage: number | null;
  directionAccuracy: number | null;
  brierScore: number | null;
  calibration: { bin: string; predicted: number; observed: number; n: number }[] | null;
  note: string;
}

export function summarizePredictor(
  predictor: string,
  predictorVersion: string,
  pairs: { prediction: PredictionInput; outcome: Outcome | null }[]
): PredictorReport {
  const counts: Record<Eligibility, number> = { scored: 0, not_comparable: 0, no_estimate: 0, synthetic: 0, late: 0, pending: 0 };
  const scored: { p: PredictionInput; s: PairScore; improvement: number }[] = [];
  for (const { prediction, outcome } of pairs) {
    const e = eligibility(outcome);
    counts[e] += 1;
    if (e === "scored" && outcome && outcome.estimate !== null) {
      scored.push({
        p: prediction,
        s: scorePair(prediction, outcome as Outcome & { estimate: number }),
        improvement: outcome.verdict === "improvement_observed" ? 1 : 0,
      });
    }
  }
  const enough = scored.length >= MIN_SCORED_PAIRS;
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const directional = scored.map((x) => x.s.directionAgrees).filter((d): d is boolean => d !== null);
  const bins = [0, 0.2, 0.4, 0.6, 0.8, 1.0001];
  return {
    predictor,
    predictorVersion,
    counts,
    scoredPairs: scored.length,
    meanAbsoluteError: enough ? mean(scored.map((x) => x.s.absoluteError)) : null,
    intervalCoverage: enough ? mean(scored.map((x) => (x.s.covered ? 1 : 0))) : null,
    directionAccuracy: enough && directional.length > 0 ? mean(directional.map((d) => (d ? 1 : 0))) : null,
    brierScore: enough ? mean(scored.map((x) => x.s.brier)) : null,
    calibration: enough
      ? bins.slice(0, -1).flatMap((lo, i) => {
          const hi = bins[i + 1] as number;
          const inBin = scored.filter((x) => x.p.probabilityImprovement >= lo && x.p.probabilityImprovement < hi);
          return inBin.length === 0
            ? []
            : [{
                bin: `${lo.toFixed(1)}–${Math.min(1, hi).toFixed(1)}`,
                predicted: mean(inBin.map((x) => x.p.probabilityImprovement)) as number,
                observed: mean(inBin.map((x) => x.improvement)) as number,
                n: inBin.length,
              }];
        })
      : null,
    note: enough
      ? "Scores compare predictions with observed associations under each plan's design; they are not causal accuracy."
      : `Only ${scored.length} scored pair(s); aggregate metrics are withheld below ${MIN_SCORED_PAIRS}.`,
  };
}

/** The descriptive prior over REAL past evaluations, or null when there is
 * not enough history (it then makes no prediction at all). */
export function descriptivePrior(pastEstimates: { estimate: number; improvement: boolean }[]): PredictionInput | null {
  if (pastEstimates.length < MIN_PRIOR_EVALUATIONS) return null;
  const sorted = pastEstimates.map((p) => p.estimate).sort((a, b) => a - b);
  const q = (f: number) => {
    const idx = (sorted.length - 1) * f;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return (sorted[lo] as number) + ((sorted[hi] as number) - (sorted[lo] as number)) * (idx - lo);
  };
  // Laplace-smoothed share of past improvements: never 0 or 1 from few data.
  const improvements = pastEstimates.filter((p) => p.improvement).length;
  return {
    predictedChange: q(0.5),
    predictedLow: q(0.1),
    predictedHigh: q(0.9),
    probabilityImprovement: (improvements + 1) / (pastEstimates.length + 2),
  };
}

export const NO_CHANGE_PREDICTION: PredictionInput = {
  predictedChange: 0,
  predictedLow: -BASELINE_HALF_WIDTH,
  predictedHigh: BASELINE_HALF_WIDTH,
  probabilityImprovement: 0.5,
};

