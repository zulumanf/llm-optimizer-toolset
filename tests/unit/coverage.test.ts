/**
 * Prompt coverage (spec 063, coverage-v1): known-answer fixtures for
 * grouping, holdout exclusion, unspecified bucketing, dimension omission,
 * and the single high-intent definition.
 */
import { describe, expect, it } from "vitest";
import type { FrozenPrompt } from "@/lib/prompts/types";
import {
  computeCoverage,
  intentBand,
  UNSPECIFIED_SEGMENT,
  type PromptPresence,
} from "@/lib/scoring/coverage";

const prompt = (over: Partial<FrozenPrompt> & { promptId: string }): FrozenPrompt => ({
  text: `q-${over.promptId}`,
  category: "recommendation",
  language: "en",
  position: 1,
  ...over,
});

const presence = (
  entries: [string, Partial<PromptPresence>][]
): Map<string, PromptPresence> =>
  new Map(
    entries.map(([id, p]) => [
      id,
      { mentioned: p.mentioned ?? false, recommended: p.recommended ?? false },
    ])
  );

function rows(dimension: string, all: ReturnType<typeof computeCoverage>) {
  return all.filter((r) => r.dimension === dimension);
}

describe("intentBand", () => {
  it("uses tier when present (tier 2 is high, tier 3 is not)", () => {
    expect(intentBand({ tier: 2, category: "how-to" })).toBe("high intent");
    expect(intentBand({ tier: 3, category: "recommendation" })).toBe("standard intent");
  });

  it("falls back to category value for untiered prompts", () => {
    expect(intentBand({ tier: null, category: "recommendation" })).toBe("high intent");
    expect(intentBand({ tier: null, category: "how-to" })).toBe("standard intent");
  });
});

describe("computeCoverage", () => {
  it("counts covered prompts per category, mentioned and recommended separately", () => {
    const result = computeCoverage(
      [
        prompt({ promptId: "a", category: "recommendation" }),
        prompt({ promptId: "b", category: "recommendation" }),
        prompt({ promptId: "c", category: "comparison" }),
      ],
      presence([
        ["a", { mentioned: true, recommended: true }],
        ["b", { mentioned: true }],
        // c: no mention rows at all
      ])
    );
    const category = rows("category", result);
    expect(category).toEqual([
      {
        dimension: "category",
        segment: "recommendation",
        promptCount: 2,
        mentionedPrompts: 2,
        recommendedPrompts: 1,
      },
      {
        dimension: "category",
        segment: "comparison",
        promptCount: 1,
        mentionedPrompts: 0,
        recommendedPrompts: 0,
      },
    ]);
  });

  it("excludes holdout prompts from every denominator", () => {
    const result = computeCoverage(
      [
        prompt({ promptId: "a" }),
        prompt({ promptId: "h", isHoldout: true }),
      ],
      presence([
        ["a", { mentioned: true }],
        ["h", { mentioned: true, recommended: true }],
      ])
    );
    const category = rows("category", result);
    expect(category).toHaveLength(1);
    expect(category[0]?.promptCount).toBe(1);
    expect(category[0]?.recommendedPrompts).toBe(0);
  });

  it("omits audience/price_tier entirely when nothing is tagged (pre-063 versions)", () => {
    const result = computeCoverage(
      [prompt({ promptId: "a" }), prompt({ promptId: "b" })],
      presence([])
    );
    expect(rows("audience", result)).toEqual([]);
    expect(rows("price_tier", result)).toEqual([]);
    // category and intent always render
    expect(rows("category", result).length).toBeGreaterThan(0);
    expect(rows("intent", result).length).toBeGreaterThan(0);
  });

  it("buckets untagged prompts as unspecified once any prompt is tagged", () => {
    const result = computeCoverage(
      [
        prompt({ promptId: "a", audience: "sellers" }),
        prompt({ promptId: "b", audience: "sellers" }),
        prompt({ promptId: "c" }),
      ],
      presence([["a", { mentioned: true }]])
    );
    const audience = rows("audience", result);
    expect(audience.map((r) => r.segment)).toEqual(["sellers", UNSPECIFIED_SEGMENT]);
    expect(audience[0]).toMatchObject({ promptCount: 2, mentionedPrompts: 1 });
    expect(audience[1]).toMatchObject({ promptCount: 1, mentionedPrompts: 0 });
  });

  it("splits intent bands using the one shared definition", () => {
    const result = computeCoverage(
      [
        prompt({ promptId: "a", tier: 1 }),
        prompt({ promptId: "b", tier: 4 }),
        prompt({ promptId: "c", tier: null, category: "how-to" }),
      ],
      presence([
        ["a", { mentioned: true, recommended: true }],
        ["b", { mentioned: true }],
      ])
    );
    const intent = rows("intent", result);
    const high = intent.find((r) => r.segment === "high intent");
    const standard = intent.find((r) => r.segment === "standard intent");
    expect(high).toMatchObject({
      promptCount: 1,
      mentionedPrompts: 1,
      recommendedPrompts: 1,
    });
    expect(standard).toMatchObject({
      promptCount: 2,
      mentionedPrompts: 1,
      recommendedPrompts: 0,
    });
  });

  it("sorts segments by prompt count, then name — stable and explainable", () => {
    const result = computeCoverage(
      [
        prompt({ promptId: "a", priceTier: "$5M+" }),
        prompt({ promptId: "b", priceTier: "$1-5M" }),
        prompt({ promptId: "c", priceTier: "$1-5M" }),
      ],
      presence([])
    );
    expect(rows("price_tier", result).map((r) => r.segment)).toEqual([
      "$1-5M",
      "$5M+",
    ]);
  });
});
