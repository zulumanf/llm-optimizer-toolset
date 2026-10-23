/**
 * Release 151 task 7: adversarial and coverage checks for lib/stats and the
 * experiment evaluator, beyond the known-answer fixtures in stats.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  differenceInDifferences,
  estimateIcc,
  estimateRate,
  minimumDetectableEffect,
  pairedDifference,
  seededRandom,
  wilsonInterval,
  type Cluster,
  type PairedCluster,
} from "@/lib/stats";
import { evaluateExperiment, type PlanInput, type Wave } from "@/lib/experiments/evaluate";

const simulate = (rand: () => number, rates: number[], reps: number): Cluster[] =>
  rates.map((p) => {
    let k = 0;
    for (let r = 0; r < reps; r += 1) if (rand() < p) k += 1;
    return { k, n: reps };
  });

describe("Wilson edge cases", () => {
  it("is bounded, ordered and symmetric", () => {
    for (const [k, n] of [[0, 1], [1, 1], [0, 1000], [1000, 1000], [3, 7]] as const) {
      const [lo, hi] = wilsonInterval(k, n)!;
      expect(lo).toBeGreaterThanOrEqual(0);
      expect(hi).toBeLessThanOrEqual(1);
      expect(lo).toBeLessThanOrEqual(k / n);
      expect(hi).toBeGreaterThanOrEqual(k / n);
      const [mlo, mhi] = wilsonInterval(n - k, n)!;
      expect(mlo).toBeCloseTo(1 - hi, 10);
      expect(mhi).toBeCloseTo(1 - lo, 10);
    }
  });
  it("rejects non-integer-consistent inputs", () => {
    expect(() => wilsonInterval(-1, 5)).toThrow(RangeError);
  });
});

describe("estimateRate adversarial inputs", () => {
  it("all-zero and all-one panels give degenerate but finite intervals", () => {
    const zeros = estimateRate(Array.from({ length: 10 }, () => ({ k: 0, n: 4 })), 1);
    expect(zeros.rate).toBe(0);
    expect(zeros.clustered).toEqual([0, 0]);
    expect(zeros.wilson![1]).toBeGreaterThan(0); // Wilson never claims certainty
    const ones = estimateRate(Array.from({ length: 10 }, () => ({ k: 4, n: 4 })), 1);
    expect(ones.clustered).toEqual([1, 1]);
  });
  it("ignores empty clusters and handles unequal cluster sizes", () => {
    const r = estimateRate([{ k: 0, n: 0 }, { k: 1, n: 1 }, { k: 9, n: 10 }, { k: 0, n: 3 }, { k: 2, n: 2 }, { k: 1, n: 4 }], 3);
    expect(r.prompts).toBe(5);
    expect(r.n).toBe(20);
    expect(r.rate).toBeCloseTo(13 / 20, 10);
    expect(Number.isFinite(r.clustered![0])).toBe(true);
  });
  it("one dominant prompt widens the clustered interval (the reason clustering exists)", () => {
    const balanced = estimateRate(Array.from({ length: 20 }, (_, i) => ({ k: i % 2 ? 2 : 1, n: 3 })), 5);
    const dominated = estimateRate([{ k: 40, n: 40 }, ...Array.from({ length: 19 }, () => ({ k: 0, n: 1 }))], 5);
    const width = (i: readonly [number, number] | null) => (i ? i[1] - i[0] : 0);
    expect(width(dominated.clustered)).toBeGreaterThan(width(balanced.clustered));
  });
});

describe("coverage (simulation)", () => {
  it("the prompt-clustered 95% interval covers the true rate ~95% under strong clustering; naive Wilson under-covers", () => {
    const rand = seededRandom(11);
    const TRIALS = 200;
    let clusteredHits = 0;
    let wilsonHits = 0;
    for (let t = 0; t < TRIALS; t += 1) {
      // Prompts are a SAMPLE from a population of buyer questions whose
      // rates vary widely (high ICC). The estimand is the population rate
      // 0.3·0.8 + 0.7·0.05 = 0.275, so prompt-sampling variance matters.
      const rates = Array.from({ length: 40 }, () => (rand() < 0.3 ? 0.8 : 0.05));
      const truth = 0.275;
      const est = estimateRate(simulate(rand, rates, 4), t + 1, 600);
      if (est.clustered && est.clustered[0] <= truth && truth <= est.clustered[1]) clusteredHits += 1;
      if (est.wilson && est.wilson[0] <= truth && truth <= est.wilson[1]) wilsonHits += 1;
    }
    const clusteredCoverage = clusteredHits / TRIALS;
    expect(clusteredCoverage).toBeGreaterThan(0.88);
    expect(clusteredCoverage).toBeLessThanOrEqual(1);
    expect(wilsonHits / TRIALS).toBeLessThan(clusteredCoverage);
  });

  it("paired difference keeps ~5% false-positive rate under the null", () => {
    const rand = seededRandom(23);
    const TRIALS = 200;
    let falsePositives = 0;
    for (let t = 0; t < TRIALS; t += 1) {
      const rates = Array.from({ length: 30 }, () => 0.05 + rand() * 0.6);
      const before = simulate(rand, rates, 4);
      const after = simulate(rand, rates, 4);
      const pairs: PairedCluster[] = rates.map((_, i) => ({ promptId: `p${i}`, before: before[i]!, after: after[i]! }));
      const d = pairedDifference(pairs, t + 7, 600);
      if (d.interval && (d.interval[0] > 0 || d.interval[1] < 0)) falsePositives += 1;
    }
    expect(falsePositives / TRIALS).toBeLessThan(0.11);
  });
});

describe("estimators are sign-correct and robust", () => {
  it("DiD removes a shared shift (index or model drift hits treated and control alike)", () => {
    const rand = seededRandom(5);
    const base = Array.from({ length: 50 }, () => 0.2 + rand() * 0.2);
    const mk = (shift: number): PairedCluster[] => {
      const b = simulate(rand, base, 6);
      const a = simulate(rand, base.map((p) => Math.min(1, p + shift)), 6);
      return base.map((_, i) => ({ promptId: `p${i}`, before: b[i]!, after: a[i]! }));
    };
    const SHARED = 0.25;
    const treated = mk(SHARED);
    const control = mk(SHARED);
    const naive = pairedDifference(treated, 1);
    expect(naive.interval![0]).toBeGreaterThan(0); // naive before/after "finds" an effect
    const did = differenceInDifferences(treated, control, 1);
    expect(did.interval![0]).toBeLessThan(0);
    expect(did.interval![1]).toBeGreaterThan(0); // DiD correctly finds none
  });
  it("ICC is in [0,1] and null without replication", () => {
    expect(estimateIcc([{ k: 0, n: 1 }])).toBeNull();
    const icc = estimateIcc([{ k: 3, n: 3 }, { k: 0, n: 5 }, { k: 2, n: 4 }]);
    expect(icc).toBeGreaterThanOrEqual(0);
    expect(icc).toBeLessThanOrEqual(1);
  });
  it("MDE is monotone: more prompts → smaller, more clustering → larger", () => {
    const m = (prompts: number, icc: number) => minimumDetectableEffect({ baselineRate: 0.2, prompts, repetitions: 4, icc })!;
    expect(m(128, 0.2)).toBeLessThan(m(64, 0.2));
    expect(m(64, 0.6)).toBeGreaterThan(m(64, 0.1));
    expect(minimumDetectableEffect({ baselineRate: 0.2, prompts: 0, repetitions: 4, icc: 0 })).toBeNull();
  });
});

describe("experiment evaluator adversarial cases", () => {
  const INSTR = "openai|m|prompt_text_only|provider_default";
  const day = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 86400000);
  const wave = (runId: string, at: Date, hits: (p: number, r: number) => boolean, served = ["m"]): Wave => {
    const answers: Wave["answers"] = [];
    const set = new Set<string>();
    for (let p = 0; p < 20; p += 1) {
      for (let r = 0; r < 4; r += 1) {
        const responseId = `${runId}:${p}:${r}`;
        answers.push({ promptId: `t${p}`, responseId });
        if (hits(p, r)) set.add(`${responseId}|e`);
      }
    }
    return { runId, startedAt: at, instrumentKey: INSTR, servedModels: served, answers, hits: set };
  };
  const plan = (over: Partial<PlanInput> = {}): PlanInput => ({
    planId: "x", entityCompanyId: "e", instrumentKey: INSTR, expectedDirection: "increase", mde: 0.1,
    design: "descriptive", targetPromptIds: [], controlPromptIds: [], controlCompanyIds: [],
    approvedAt: day(0), shippedAt: day(20), estimatedCostUsd: null, knownConfounders: [], ...over,
  });

  it("expected_direction 'decrease' turns a drop into improvement and a rise into a negative change", () => {
    const base = [wave("b1", day(1), (p, r) => r < 3), wave("b2", day(10), (p, r) => r < 3)];
    const drop = [wave("p", day(30), (p, r) => r < 1)];
    expect(evaluateExperiment(plan({ expectedDirection: "decrease" }), base, drop).verdict).toBe("improvement_observed");
    expect(evaluateExperiment(plan({ expectedDirection: "increase" }), base, drop).verdict).toBe("negative_change_observed");
  });
  it("a served-model swap in either direction is not comparable", () => {
    const base = [wave("b1", day(1), () => true, ["m-a", "m-b"])];
    const after = [wave("p", day(30), () => true, ["m-a"])];
    expect(evaluateExperiment(plan(), base, after).verdict).toBe("not_comparable");
  });
  it("a post wave from before shipping is never evidence", () => {
    const base = [wave("b1", day(1), () => false)];
    const early = [wave("p", day(15), () => true)];
    expect(evaluateExperiment(plan(), base, early).verdict).toBe("not_comparable");
  });
  it("a disjoint prompt panel produces no estimate, never a fabricated one", () => {
    const base = [wave("b1", day(1), () => false)];
    const after: Wave[] = [{ ...wave("p", day(30), () => true), answers: [{ promptId: "other", responseId: "z" }] }];
    const e = evaluateExperiment(plan(), base, after);
    expect(e.estimate).toBeNull();
    expect(e.verdict).toBe("inconclusive");
  });
});
