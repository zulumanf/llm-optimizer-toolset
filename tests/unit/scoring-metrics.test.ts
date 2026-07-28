import { describe, expect, it } from "vitest";
import {
  computeProviderMetrics,
  authorityScore,
  aggregateAcrossProviders,
  AUTHORITY_WEIGHTS,
  type CompanyProviderInput,
} from "@/lib/scoring/metrics";
import { detectBrandCandidates } from "@/lib/parsing/candidates";

function input(overrides: Partial<CompanyProviderInput>): CompanyProviderInput {
  return {
    n: 10,
    mentionedResponses: 0,
    recommendedResponses: 0,
    companyMentions: 0,
    totalTrackedMentions: 0,
    listPositions: [],
    sentiments: [],
    citedResponses: 0,
    responsesWithAnyCitation: 0,
    ...overrides,
  };
}

describe("computeProviderMetrics (docs/06 known answers)", () => {
  it("computes rates and share of voice", () => {
    const values = computeProviderMetrics(
      input({
        mentionedResponses: 6,
        recommendedResponses: 3,
        companyMentions: 6,
        totalTrackedMentions: 15,
      })
    );
    expect(values.mention_rate).toBeCloseTo(0.6);
    expect(values.recommendation_rate).toBeCloseTo(0.3);
    expect(values.share_of_voice).toBeCloseTo(6 / 15);
  });

  it("position score: mean of 1/position, null below 5 listing cells", () => {
    expect(
      computeProviderMetrics(input({ listPositions: [1, 2, 4, 1, 2] })).position_score
    ).toBeCloseTo((1 + 0.5 + 0.25 + 1 + 0.5) / 5);
    expect(
      computeProviderMetrics(input({ listPositions: [1, 1, 1, 1] })).position_score
    ).toBeNull();
  });

  it("sentiment index maps pos/neutral/neg to 1/0.5/0, null below 5 cells", () => {
    expect(
      computeProviderMetrics(
        input({ sentiments: ["positive", "positive", "neutral", "mixed", "negative"] })
      ).sentiment_index
    ).toBeCloseTo((1 + 1 + 0.5 + 0.5 + 0) / 5);
    expect(
      computeProviderMetrics(input({ sentiments: ["positive"] })).sentiment_index
    ).toBeNull();
  });

  it("citation score is null when the provider never returns citations", () => {
    expect(
      computeProviderMetrics(input({ responsesWithAnyCitation: 0 })).citation_score
    ).toBeNull();
    expect(
      computeProviderMetrics(
        input({ citedResponses: 2, responsesWithAnyCitation: 8 })
      ).citation_score
    ).toBeCloseTo(0.25);
  });

  it("share of voice is null with zero tracked mentions (not 0)", () => {
    expect(
      computeProviderMetrics(input({ totalTrackedMentions: 0 })).share_of_voice
    ).toBeNull();
  });
});

describe("authorityScore", () => {
  it("matches the hand-computed weighted sum with all components", () => {
    const values = {
      recommendation_rate: 0.4,
      mention_rate: 0.8,
      share_of_voice: 0.5,
      position_score: 0.6,
      citation_score: 0.2,
      sentiment_index: 0.9,
    };
    // 100 × (.35×.4 + .2×.8 + .15×.5 + .15×.6 + .1×.2 + .05×.9)
    expect(authorityScore(values)).toBeCloseTo(
      100 * (0.14 + 0.16 + 0.075 + 0.09 + 0.02 + 0.045)
    );
  });

  it("redistributes null components' weight proportionally", () => {
    // Only rec (0.35) and mention (0.2) present → weights become 35/55, 20/55
    const values = {
      recommendation_rate: 1,
      mention_rate: 0,
      share_of_voice: null,
      position_score: null,
      citation_score: null,
      sentiment_index: null,
    };
    expect(authorityScore(values)).toBeCloseTo(100 * (0.35 / 0.55));
  });

  it("is null when every component is null", () => {
    expect(authorityScore({})).toBeNull();
  });

  it("weights sum to 1", () => {
    expect(
      Object.values(AUTHORITY_WEIGHTS).reduce((a, b) => a + b, 0)
    ).toBeCloseTo(1);
  });
});

describe("aggregateAcrossProviders", () => {
  it("takes the unweighted mean and skips nulls", () => {
    expect(aggregateAcrossProviders([0.2, 0.4])).toBeCloseTo(0.3);
    expect(aggregateAcrossProviders([0.2, null, 0.4])).toBeCloseTo(0.3);
    expect(aggregateAcrossProviders([null, null])).toBeNull();
  });
});

describe("detectBrandCandidates", () => {
  const known = ["Parva", "parva.com", "Acme"];

  it("finds capitalized mid-sentence brands not in the tracked set", () => {
    const found = detectBrandCandidates(
      "Many teams pick Gamma Tools or Acme for this.",
      known
    );
    expect(found).toEqual(["Gamma Tools"]);
  });

  it("ignores sentence-start capitalization and list-marker starts", () => {
    expect(detectBrandCandidates("Delta is fine. Epsilon too.", known)).toEqual([]);
    expect(detectBrandCandidates("1. Zeta\n2. Parva", known)).toEqual([]);
  });

  it("ignores stopword-only sequences", () => {
    expect(
      detectBrandCandidates("and The Best Tools are here", known)
    ).toEqual([]);
  });

  it("ignores markdown headers, bold labels, and table structure (real GPT shapes)", () => {
    const markdownAnswer = [
      "**Bottom line:** it depends on your needs.",
      "## Comparison",
      "| Dimension | Notes |",
      "|---|---|",
      "| Loyalty | strong |",
      "1. **Wanderlog** — collaborative planning",
      "Many travelers also use TripIt for itineraries.",
    ].join("\n");
    const found = detectBrandCandidates(markdownAnswer, known);
    expect(found).toContain("TripIt");
    expect(found).not.toContain("Bottom");
    expect(found).not.toContain("Comparison");
    expect(found).not.toContain("Dimension");
    expect(found).not.toContain("Loyalty");
  });

  it("rejects header-like 'Word:' shapes even mid-line", () => {
    expect(
      detectBrandCandidates("things to weigh — Verdict: choose wisely", known)
    ).toEqual([]);
  });
});
