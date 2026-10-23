import { describe, expect, it } from "vitest";
import {
  designEffect,
  differenceInDifferences,
  estimateIcc,
  estimateRate,
  intervalExcludesZero,
  minimumDetectableEffect,
  pairClusters,
  pairedDifference,
  seededRandom,
  seedFromKey,
  wilsonInterval,
  type Cluster,
  type PairedCluster,
} from "@/lib/stats";

function simulatePanel(
  rand: () => number,
  rates: number[],
  reps: number
): Cluster[] {
  return rates.map((p) => {
    let k = 0;
    for (let r = 0; r < reps; r += 1) if (rand() < p) k += 1;
    return { k, n: reps };
  });
}

describe("wilsonInterval (known answers)", () => {
  it("25/256 → 6.70%–14.02%", () => {
    const ci = wilsonInterval(25, 256);
    expect(ci?.[0]).toBeCloseTo(0.0670, 3);
    expect(ci?.[1]).toBeCloseTo(0.1402, 3);
  });
  it("0/10 → 0–27.75% (never a degenerate zero-width interval)", () => {
    const ci = wilsonInterval(0, 10);
    expect(ci?.[0]).toBe(0);
    expect(ci?.[1]).toBeCloseTo(0.2775, 3);
  });
  it("n = 0 is unmeasurable, not zero", () => {
    expect(wilsonInterval(0, 0)).toBeNull();
  });
  it("rejects impossible counts", () => {
    expect(() => wilsonInterval(5, 4)).toThrow(RangeError);
  });
});

describe("seeded randomness", () => {
  it("same seed, same sequence; key hashing is stable", () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    expect(seedFromKey("run|company|metric")).toBe(seedFromKey("run|company|metric"));
    expect(seedFromKey("a")).not.toBe(seedFromKey("b"));
  });
});

describe("estimateRate", () => {
  it("is reproducible for a fixed seed and wider than Wilson under clustering", () => {
    // 20 prompts, perfectly clustered: each prompt all-yes or all-no
    const clusters: Cluster[] = Array.from({ length: 20 }, (_, i) => ({
      k: i < 5 ? 4 : 0,
      n: 4,
    }));
    const one = estimateRate(clusters, 7);
    const two = estimateRate(clusters, 7);
    expect(one).toEqual(two);
    expect(one.rate).toBeCloseTo(0.25, 10);
    expect(one.prompts).toBe(20);
    const wilsonWidth = (one.wilson?.[1] ?? 0) - (one.wilson?.[0] ?? 0);
    const clusteredWidth = (one.clustered?.[1] ?? 0) - (one.clustered?.[0] ?? 0);
    expect(clusteredWidth).toBeGreaterThan(wilsonWidth);
  });
  it("reports no clustered interval below the cluster minimum", () => {
    const r = estimateRate([{ k: 1, n: 4 }, { k: 0, n: 4 }], 1);
    expect(r.clustered).toBeNull();
    expect(r.wilson).not.toBeNull();
  });
  it("empty input is unmeasurable", () => {
    expect(estimateRate([], 1).rate).toBeNull();
  });
});

describe("estimateIcc / designEffect / MDE", () => {
  it("perfect within-prompt agreement → ICC 1", () => {
    const clusters = Array.from({ length: 10 }, (_, i) => ({ k: i % 2 === 0 ? 4 : 0, n: 4 }));
    expect(estimateIcc(clusters)).toBeCloseTo(1, 6);
  });
  it("independent answers → ICC near 0", () => {
    const rand = seededRandom(99);
    const clusters = simulatePanel(rand, Array(400).fill(0.3), 4);
    expect(estimateIcc(clusters) ?? 1).toBeLessThan(0.08);
  });
  it("cannot be estimated without replication", () => {
    expect(estimateIcc([{ k: 1, n: 1 }, { k: 0, n: 1 }])).toBeNull();
  });
  it("design effect = 1 + (m − 1)·ICC", () => {
    expect(designEffect(4, 0.5)).toBeCloseTo(2.5, 10);
  });
  it("MDE known answers: p=0.2, 64 prompts × 4 reps", () => {
    expect(
      minimumDetectableEffect({ baselineRate: 0.2, prompts: 64, repetitions: 4, icc: 0 })
    ).toBeCloseTo(0.0991, 3);
    expect(
      minimumDetectableEffect({ baselineRate: 0.2, prompts: 64, repetitions: 4, icc: 0.5 })
    ).toBeCloseTo(0.1566, 3);
  });
});

describe("pairedDifference / differenceInDifferences", () => {
  it("pairs only prompts present on both sides", () => {
    const pairs = pairClusters(
      new Map([["a", { k: 1, n: 4 }], ["b", { k: 2, n: 4 }]]),
      new Map([["b", { k: 3, n: 4 }], ["c", { k: 4, n: 4 }]])
    );
    expect(pairs.map((p) => p.promptId)).toEqual(["b"]);
  });

  it("recovers a known simulated treatment effect within its interval, and a null control excludes no zero", () => {
    const rand = seededRandom(2026);
    const promptRates = Array.from({ length: 60 }, () => 0.1 + rand() * 0.3);
    const TRUE_EFFECT = 0.2;
    const build = (lift: number): PairedCluster[] => {
      const before = simulatePanel(rand, promptRates, 4);
      const after = simulatePanel(rand, promptRates.map((p) => Math.min(1, p + lift)), 4);
      return before.map((b, i) => ({ promptId: `p${i}`, before: b, after: after[i] as Cluster }));
    };
    const treated = build(TRUE_EFFECT);
    const control = build(0);

    const did = differenceInDifferences(treated, control, 11);
    expect(did.interval).not.toBeNull();
    const [lo, hi] = did.interval as readonly [number, number];
    expect(lo).toBeLessThanOrEqual(TRUE_EFFECT);
    expect(hi).toBeGreaterThanOrEqual(TRUE_EFFECT);
    expect(intervalExcludesZero(did.interval)).toBe(true);

    const nullDiff = pairedDifference(control, 5);
    expect(intervalExcludesZero(nullDiff.interval)).toBe(false);
  });

  it("is deterministic for a seed", () => {
    const pairs: PairedCluster[] = Array.from({ length: 8 }, (_, i) => ({
      promptId: `p${i}`,
      before: { k: i % 3, n: 4 },
      after: { k: (i + 1) % 4, n: 4 },
    }));
    expect(pairedDifference(pairs, 3)).toEqual(pairedDifference(pairs, 3));
  });
});
