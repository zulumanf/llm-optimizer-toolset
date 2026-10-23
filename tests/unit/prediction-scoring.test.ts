import { describe, expect, it } from "vitest";
import {
  descriptivePrior,
  eligibility,
  MIN_PRIOR_EVALUATIONS,
  MIN_SCORED_PAIRS,
  NO_CHANGE_PREDICTION,
  scorePair,
  summarizePredictor,
  type Outcome,
} from "@/lib/experiments/prediction-scoring";

const outcome = (over: Partial<Outcome> = {}): Outcome => ({
  verdict: "improvement_observed",
  estimate: 0.2,
  comparable: true,
  synthetic: false,
  recordedBeforeShipping: true,
  ...over,
});

describe("prediction eligibility", () => {
  it("scores only comparable, real, pre-shipping outcomes with an estimate", () => {
    expect(eligibility(null)).toBe("pending");
    expect(eligibility(outcome({ synthetic: true }))).toBe("synthetic");
    expect(eligibility(outcome({ recordedBeforeShipping: false }))).toBe("late");
    expect(eligibility(outcome({ verdict: "not_comparable", comparable: false }))).toBe("not_comparable");
    expect(eligibility(outcome({ estimate: null, verdict: "inconclusive" }))).toBe("no_estimate");
    expect(eligibility(outcome())).toBe("scored");
  });
});

describe("scorePair (known answers)", () => {
  it("computes absolute error, coverage, direction and Brier", () => {
    const s = scorePair({ predictedChange: 0.1, predictedLow: 0, predictedHigh: 0.3, probabilityImprovement: 0.7 }, { ...outcome(), estimate: 0.2 });
    expect(s.absoluteError).toBeCloseTo(0.1, 10);
    expect(s.covered).toBe(true);
    expect(s.directionAgrees).toBe(true);
    expect(s.brier).toBeCloseTo(0.09, 10);
    const miss = scorePair({ predictedChange: 0.1, predictedLow: 0, predictedHigh: 0.3, probabilityImprovement: 0.7 }, { ...outcome({ verdict: "negative_change_observed" }), estimate: -0.2 });
    expect(miss.covered).toBe(false);
    expect(miss.directionAgrees).toBe(false);
    expect(miss.brier).toBeCloseTo(0.49, 10);
    expect(scorePair(NO_CHANGE_PREDICTION, { ...outcome(), estimate: 0.2 }).directionAgrees).toBeNull();
  });
});

describe("summarizePredictor", () => {
  it("withholds aggregates below the minimum and never counts synthetic outcomes", () => {
    const pairs = Array.from({ length: 30 }, () => ({ prediction: NO_CHANGE_PREDICTION, outcome: outcome({ synthetic: true }) }));
    const r = summarizePredictor("no-change", "v1", pairs);
    expect(r.counts.synthetic).toBe(30);
    expect(r.scoredPairs).toBe(0);
    expect(r.meanAbsoluteError).toBeNull();
    expect(r.note).toMatch(/withheld/);
  });
  it("reports calibration and proper scores once there is enough real data", () => {
    const pairs = Array.from({ length: MIN_SCORED_PAIRS }, (_, i) => ({
      prediction: { predictedChange: 0.1, predictedLow: -0.05, predictedHigh: 0.25, probabilityImprovement: 0.5 },
      outcome: outcome({ estimate: i % 2 ? 0.1 : 0, verdict: i % 2 ? "improvement_observed" : "no_detectable_change" }),
    }));
    const r = summarizePredictor("x", "v1", pairs);
    expect(r.brierScore).toBeCloseTo(0.25, 10);
    expect(r.intervalCoverage).toBe(1);
    expect(r.calibration).toEqual([{ bin: "0.4–0.6", predicted: 0.5, observed: 0.5, n: MIN_SCORED_PAIRS }]);
    expect(r.note).toMatch(/not causal/);
  });
});

describe("descriptivePrior", () => {
  it("refuses to predict without enough real history", () => {
    expect(descriptivePrior(Array.from({ length: MIN_PRIOR_EVALUATIONS - 1 }, () => ({ estimate: 0.1, improvement: true })))).toBeNull();
  });
  it("uses median, 10–90% range and a smoothed improvement share", () => {
    const p = descriptivePrior([0, 0.05, 0.1, 0.15, 0.2].map((estimate, i) => ({ estimate, improvement: i >= 3 })))!;
    expect(p.predictedChange).toBeCloseTo(0.1, 10);
    expect(p.predictedLow).toBeCloseTo(0.02, 10);
    expect(p.predictedHigh).toBeCloseTo(0.18, 10);
    expect(p.probabilityImprovement).toBeCloseTo(3 / 7, 10);
  });
});
