import { describe, expect, it } from "vitest";
import { cohensKappa, fieldReport, humanTruth, seededShuffle, type PairEvidence } from "@/lib/evaluation/metrics";
import { seededRandom } from "@/lib/stats";

const L = (mentioned: boolean, recommended: boolean) => ({ sameEntity: true, mentioned, recommended });

describe("humanTruth", () => {
  it("adjudication wins; one annotator is not validation; disagreement is disputed", () => {
    const base = { itemId: "i", classifier: null };
    expect(humanTruth({ ...base, annotations: [L(true, true)], adjudication: L(true, false) }, "recommended")).toEqual({ status: "adjudicated", value: false });
    expect(humanTruth({ ...base, annotations: [L(true, true)], adjudication: null }, "recommended").status).toBe("single");
    expect(humanTruth({ ...base, annotations: [L(true, true), L(true, true)], adjudication: null }, "recommended")).toEqual({ status: "unanimous", value: true });
    expect(humanTruth({ ...base, annotations: [L(true, true), L(true, false)], adjudication: null }, "recommended").status).toBe("disputed");
  });
});

describe("fieldReport (known answers)", () => {
  it("counts only validated pairs and computes precision/recall", () => {
    const two = (m: boolean, r: boolean) => [L(m, r), L(m, r)];
    const pairs: PairEvidence[] = [
      { itemId: "tp1", annotations: two(true, true), adjudication: null, classifier: { mentioned: true, recommended: true } },
      { itemId: "tp2", annotations: two(true, true), adjudication: null, classifier: { mentioned: true, recommended: true } },
      { itemId: "fp", annotations: two(true, false), adjudication: null, classifier: { mentioned: true, recommended: true } },
      { itemId: "fn", annotations: two(true, true), adjudication: null, classifier: { mentioned: true, recommended: false } },
      { itemId: "tn", annotations: two(false, false), adjudication: null, classifier: { mentioned: false, recommended: false } },
      { itemId: "single", annotations: [L(true, true)], adjudication: null, classifier: { mentioned: true, recommended: false } },
      { itemId: "disputed", annotations: [L(true, true), L(true, false)], adjudication: null, classifier: { mentioned: true, recommended: true } },
    ];
    const r = fieldReport(pairs, "recommended");
    expect(r).toMatchObject({ validatedPairs: 5, singleAnnotatorPairs: 1, disputedPairs: 1, truePositive: 2, falsePositive: 1, falseNegative: 1, trueNegative: 1 });
    expect(r.precision).toBeCloseTo(2 / 3, 10);
    expect(r.recall).toBeCloseTo(2 / 3, 10);
    expect(r.precisionInterval).not.toBeNull();
  });
  it("no validated pairs → null metrics, never 100%", () => {
    const r = fieldReport([{ itemId: "x", annotations: [L(true, true)], adjudication: null, classifier: { mentioned: true, recommended: true } }], "recommended");
    expect(r.precision).toBeNull();
    expect(r.recall).toBeNull();
  });
});

describe("cohensKappa", () => {
  it("perfect agreement with variation → 1", () => {
    const pairs: PairEvidence[] = [
      { itemId: "a", annotations: [L(true, true), L(true, true)], adjudication: null, classifier: null },
      { itemId: "b", annotations: [L(true, false), L(true, false)], adjudication: null, classifier: null },
    ];
    expect(cohensKappa(pairs, "recommended")).toBe(1);
  });
  it("chance-level agreement → 0", () => {
    const pairs: PairEvidence[] = [
      { itemId: "a", annotations: [L(true, true), L(true, true)], adjudication: null, classifier: null },
      { itemId: "b", annotations: [L(true, true), L(true, false)], adjudication: null, classifier: null },
      { itemId: "c", annotations: [L(true, false), L(true, true)], adjudication: null, classifier: null },
      { itemId: "d", annotations: [L(true, false), L(true, false)], adjudication: null, classifier: null },
    ];
    expect(cohensKappa(pairs, "recommended")).toBeCloseTo(0, 10);
  });
});

describe("seededShuffle", () => {
  it("is a reproducible permutation", () => {
    const a = seededShuffle([1, 2, 3, 4, 5], seededRandom(3));
    const b = seededShuffle([1, 2, 3, 4, 5], seededRandom(3));
    expect(a).toEqual(b);
    expect([...a].sort()).toEqual([1, 2, 3, 4, 5]);
  });
});
