import { describe, expect, it } from "vitest";
import { stabilityLabel } from "@/lib/evidence/stability";
import { selectAuditSample, mulberry32 } from "@/lib/evidence/sampler";

describe("stabilityLabel (deterministic n=5 table)", () => {
  it("matches the canonical five-observation table", () => {
    expect(stabilityLabel(5, 5).label).toBe("established");
    expect(stabilityLabel(4, 5).label).toBe("established");
    expect(stabilityLabel(3, 5).label).toBe("emerging");
    expect(stabilityLabel(2, 5).label).toBe("emerging");
    expect(stabilityLabel(1, 5).label).toBe("volatile");
    expect(stabilityLabel(0, 5).label).toBe("absent");
  });

  it("maps other sample sizes by proportion, keeping k/n", () => {
    expect(stabilityLabel(2, 10)).toEqual({
      label: "volatile",
      appearances: 2,
      observations: 10,
    });
    expect(stabilityLabel(2, 2).label).toBe("established");
    expect(stabilityLabel(1, 3).label).toBe("emerging"); // 1/3 > 1/5
  });

  it("rejects invalid inputs", () => {
    expect(() => stabilityLabel(3, 0)).toThrow();
    expect(() => stabilityLabel(6, 5)).toThrow();
  });
});

describe("selectAuditSample (seeded, reproducible)", () => {
  const candidates = [
    { id: "a", positive: true, provider: "openai" },
    { id: "b", positive: false, provider: "openai" },
    { id: "c", positive: false, provider: "mock" },
    { id: "d", positive: true, provider: "mock" },
    { id: "e", positive: false, provider: "openai" },
    { id: "f", positive: false, provider: "mock" },
  ];

  it("is exactly reproducible from the same seed", () => {
    const one = selectAuditSample(candidates, 4, 42);
    const two = selectAuditSample(candidates, 4, 42);
    expect(one.selectedIds).toEqual(two.selectedIds);
  });

  it("different seeds generally differ", () => {
    const seeds = [1, 2, 3, 4, 5].map(
      (s) => selectAuditSample(candidates, 4, s).selectedIds.join(",")
    );
    expect(new Set(seeds).size).toBeGreaterThan(1);
  });

  it("satisfies positive/negative/multi-provider constraints when satisfiable", () => {
    for (const seed of [1, 7, 99, 1234]) {
      const result = selectAuditSample(candidates, 3, seed);
      expect(result.constraintsMet.hasPositive).toBe(true);
      expect(result.constraintsMet.hasNegative).toBe(true);
      expect(result.constraintsMet.multiProvider).toBe(true);
    }
  });

  it("degrades gracefully when no positives exist, and reports it", () => {
    const negativesOnly = candidates.map((c) => ({ ...c, positive: false }));
    const result = selectAuditSample(negativesOnly, 3, 5);
    expect(result.selectedIds).toHaveLength(3);
    expect(result.constraintsMet.hasPositive).toBe(false);
    expect(result.constraintsMet.satisfiable.positive).toBe(false);
  });

  it("caps at the candidate count without duplicates", () => {
    const result = selectAuditSample(candidates.slice(0, 2), 10, 8);
    expect(result.selectedIds).toHaveLength(2);
    expect(new Set(result.selectedIds).size).toBe(2);
  });

  it("mulberry32 is deterministic", () => {
    const a = mulberry32(123);
    const b = mulberry32(123);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});
