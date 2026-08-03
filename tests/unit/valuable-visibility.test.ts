/**
 * Known-answer tests for valuable visibility (spec 038) and the unified
 * commercial-intent weight. Every expected number is derived by hand.
 */
import { describe, expect, it } from "vitest";
import {
  CATEGORY_INTENT_VALUE,
  commercialIntentWeight,
  INTENT_TIER_WEIGHTS,
} from "@/lib/scoring/intent";
import {
  cellCredit,
  valuableVisibilityFromCells,
  type VisibilityCell,
} from "@/lib/scoring/valuable";

const cell = (over: Partial<VisibilityCell>): VisibilityCell => ({
  tier: null,
  category: "recommendation",
  promptNamedCompany: false,
  mentioned: false,
  recommended: false,
  listPosition: null,
  ...over,
});

describe("commercialIntentWeight", () => {
  it("prefers the tier when present", () => {
    expect(commercialIntentWeight({ tier: 1, category: "how-to" })).toBe(1.0);
    expect(commercialIntentWeight({ tier: 4, category: "recommendation" })).toBe(0.4);
  });
  it("falls back to the category value, then to 0.5", () => {
    expect(commercialIntentWeight({ tier: null, category: "problem" })).toBe(0.9);
    expect(commercialIntentWeight({ tier: null, category: "unheard-of" })).toBe(0.5);
    expect(commercialIntentWeight({})).toBe(0.5);
  });
  it("category table matches the gap detector's historical values exactly", () => {
    // Moved verbatim from lib/gaps/detect.ts — gap scores must not change.
    expect(CATEGORY_INTENT_VALUE).toEqual({
      recommendation: 1.0,
      problem: 0.9,
      comparison: 0.8,
      branded: 0.6,
      "how-to": 0.4,
    });
    expect(INTENT_TIER_WEIGHTS).toEqual({ 1: 1.0, 2: 0.8, 3: 0.6, 4: 0.4 });
  });
});

describe("cellCredit", () => {
  it("composes 0.5 mentioned + 0.35 recommended + 0.15 top-3", () => {
    expect(cellCredit({ mentioned: false, recommended: false, listPosition: 1 })).toBe(0);
    expect(cellCredit({ mentioned: true, recommended: false, listPosition: null })).toBe(0.5);
    expect(cellCredit({ mentioned: true, recommended: true, listPosition: null })).toBe(0.85);
    expect(cellCredit({ mentioned: true, recommended: true, listPosition: 3 })).toBe(1);
    expect(cellCredit({ mentioned: true, recommended: true, listPosition: 4 })).toBe(0.85);
  });
});

describe("valuableVisibilityFromCells", () => {
  it("is null — not zero — when every cell is branded echo", () => {
    const result = valuableVisibilityFromCells([
      cell({ promptNamedCompany: true, mentioned: true, recommended: true }),
    ]);
    expect(result.score).toBeNull();
    expect(result.weightedMentionRate).toBeNull();
    expect(result.organicResponses).toBe(0);
    expect(result.brandedExcluded).toBe(1);
  });

  it("excludes branded cells from every rate", () => {
    const result = valuableVisibilityFromCells([
      cell({ promptNamedCompany: true, mentioned: true, recommended: true, listPosition: 1 }),
      cell({ mentioned: false }),
    ]);
    // Only the organic unmentioned cell counts.
    expect(result.score).toBe(0);
    expect(result.weightedMentionRate).toBe(0);
    expect(result.organicResponses).toBe(1);
    expect(result.brandedExcluded).toBe(1);
  });

  it("weights cells by commercial intent — a high-intent miss hurts more", () => {
    // Two cells: tier-1 (w=1.0) not mentioned; tier-4 (w=0.4) mentioned.
    const result = valuableVisibilityFromCells([
      cell({ tier: 1, mentioned: false }),
      cell({ tier: 4, mentioned: true }),
    ]);
    // weightedMentionRate = (1.0×0 + 0.4×1) / 1.4
    expect(result.weightedMentionRate).toBeCloseTo(0.4 / 1.4, 10);
    // score = 100 × (0.4 × 0.5) / 1.4
    expect(result.score).toBeCloseTo((100 * 0.4 * 0.5) / 1.4, 10);
    // If the weights were flipped, the rate would be 1.0/1.4 — asserted to
    // show weighting direction matters.
    const flipped = valuableVisibilityFromCells([
      cell({ tier: 4, mentioned: false }),
      cell({ tier: 1, mentioned: true }),
    ]);
    expect(flipped.weightedMentionRate).toBeCloseTo(1.0 / 1.4, 10);
  });

  it("aggregates repeated runs as cells: 2 prompts × 3 reps = 6 cells", () => {
    const reps = (tier: number, mentioned: boolean) =>
      Array.from({ length: 3 }, () => cell({ tier, mentioned }));
    const result = valuableVisibilityFromCells([...reps(1, true), ...reps(1, false)]);
    expect(result.organicResponses).toBe(6);
    expect(result.weightedMentionRate).toBeCloseTo(0.5, 10);
    expect(result.score).toBeCloseTo(100 * 0.5 * 0.5, 10); // half the cells at credit 0.5
  });

  it("high-intent rate is a plain rate over w ≥ 0.8 cells, null when none exist", () => {
    const result = valuableVisibilityFromCells([
      cell({ tier: 1, mentioned: true }), // high-intent
      cell({ tier: 2, mentioned: false }), // high-intent
      cell({ tier: 4, mentioned: true }), // not
    ]);
    expect(result.highIntentMentionRate).toBeCloseTo(0.5, 10);
    const none = valuableVisibilityFromCells([cell({ tier: 4, mentioned: true })]);
    expect(none.highIntentMentionRate).toBeNull();
    expect(none.score).not.toBeNull();
  });

  it("full marks: every organic cell recommended at position 1 on tier 1", () => {
    const result = valuableVisibilityFromCells([
      cell({ tier: 1, mentioned: true, recommended: true, listPosition: 1 }),
      cell({ tier: 1, mentioned: true, recommended: true, listPosition: 2 }),
    ]);
    expect(result.score).toBe(100);
    expect(result.weightedRecommendationRate).toBe(1);
  });
});
