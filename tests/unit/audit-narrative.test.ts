/**
 * Audit page narrative states (spec 123): the hero must tell the story the
 * counts support — zero, low, strong, leader — and fall back to the frozen
 * generator headline on snapshots without a stakes block. Plus the two
 * honesty helpers: the comparison-basis sentence (never a bare "0 / 354")
 * and the published-answers note (never "all answers" unless provable).
 */
import { describe, expect, it } from "vitest";
import {
  comparisonBasisNote,
  heroHeadline,
  heroSupportLine,
  narrativeState,
  plainSystemsPhrase,
  publishedAnswersNote,
} from "@/components/audit/narrative";
import { visibilityThreshold } from "@/lib/prospects/constants";

const ctx = {
  prospectName: "The Rivera Team",
  marketName: "Jersey City",
  legacyHeadline: "Frozen generator headline.",
};

describe("narrativeState", () => {
  const base = {
    responseCount: 512,
    prospectRowRecommendations: null,
    topRivalRecommendations: 40,
  };

  it("zero recommendations → zero", () => {
    expect(narrativeState({ ...base, yourRecommendations: 0 })).toBe("zero");
  });

  it("below the visibility threshold → low", () => {
    const threshold = visibilityThreshold(512);
    expect(
      narrativeState({ ...base, yourRecommendations: Math.floor(threshold) - 1 })
    ).toBe("low");
  });

  it("at or above the threshold with a rival counted higher → strong", () => {
    expect(
      narrativeState({
        ...base,
        yourRecommendations: 110,
        prospectRowRecommendations: 110,
        topRivalRecommendations: 140,
      })
    ).toBe("strong");
  });

  it("at or above the threshold with no rival counted higher → leader", () => {
    expect(
      narrativeState({
        ...base,
        yourRecommendations: 150,
        prospectRowRecommendations: 150,
        topRivalRecommendations: 140,
      })
    ).toBe("leader");
  });

  it("leader comparison uses the comparison-table basis when present", () => {
    // Full-run count clears every rival, but on the table's own basis a
    // rival counted higher — the like-for-like comparison wins.
    expect(
      narrativeState({
        responseCount: 512,
        yourRecommendations: 150,
        prospectRowRecommendations: 90,
        topRivalRecommendations: 100,
      })
    ).toBe("strong");
  });

  it("no stakes block (older snapshot) → legacy", () => {
    expect(narrativeState({ ...base, yourRecommendations: null })).toBe("legacy");
  });

  it("small samples floor the threshold at 5", () => {
    // 4 of 12 answers is above 20% but below the floor of 5 — still low.
    expect(
      narrativeState({
        responseCount: 12,
        yourRecommendations: 4,
        prospectRowRecommendations: 4,
        topRivalRecommendations: 6,
      })
    ).toBe("low");
  });
});

describe("heroHeadline", () => {
  it("zero: past-tense, benchmark-scoped absence", () => {
    const h = heroHeadline("zero", ctx);
    expect(h).toContain("Jersey City");
    expect(h).toContain("wasn't recommended");
    // Never a universal-absence claim — the count is scoped to this test.
    expect(h).not.toMatch(/never/i);
  });

  it("low: rarely the recommendation", () => {
    expect(heroHeadline("low", ctx)).toContain("rarely the recommendation");
  });

  it("strong: acknowledges presence before opportunity", () => {
    const h = heroHeadline("strong", ctx);
    expect(h).toContain("already shows up");
    expect(h).toContain("recommended more often");
  });

  it("leader: defend-the-position framing, still test-scoped", () => {
    const h = heroHeadline("leader", ctx);
    expect(h).toContain("leads this test");
    expect(h).toContain("no Jersey City team was recommended more often");
  });

  it("legacy: renders the frozen generator headline verbatim", () => {
    expect(heroHeadline("legacy", ctx)).toBe("Frozen generator headline.");
  });
});

describe("heroSupportLine", () => {
  it("zero/low with counted competitors: others were recommended instead", () => {
    for (const state of ["zero", "low"] as const) {
      expect(
        heroSupportLine(state, {
          marketName: "Jersey City",
          competitorsWereRecommended: true,
        })
      ).toContain("recommended instead");
    }
  });

  it("zero with NO counted competitors says nothing — never an invented loss", () => {
    expect(
      heroSupportLine("zero", {
        marketName: "Jersey City",
        competitorsWereRecommended: false,
      })
    ).toBeNull();
  });

  it("leader: defend and widen", () => {
    expect(
      heroSupportLine("leader", {
        marketName: "Jersey City",
        competitorsWereRecommended: true,
      })
    ).toContain("defend");
  });
});

describe("plainSystemsPhrase", () => {
  it("names the consumer counterparts of the tested providers", () => {
    expect(plainSystemsPhrase(["openai", "perplexity"])).toBe(
      "the systems behind ChatGPT and Perplexity"
    );
  });

  it("single provider reads singular", () => {
    expect(plainSystemsPhrase(["openai"])).toBe("the system behind ChatGPT");
  });

  it("unknown providers stay neutral, never a guessed brand", () => {
    expect(plainSystemsPhrase(["mock"])).toBe("the AI systems we tested");
  });
});

describe("comparisonBasisNote — one denominator, subsets explained", () => {
  it("silent when the bases match", () => {
    expect(comparisonBasisNote(512, 512)).toBeNull();
    expect(comparisonBasisNote(null, 512)).toBeNull();
  });

  it("explains a frozen counting basis in one sentence (the 354-of-512 case)", () => {
    const note = comparisonBasisNote(354, 512);
    expect(note).toContain("354 answers analyzed");
    expect(note).toContain("512 captured in total");
  });
});

describe("publishedAnswersNote — no completeness overclaim", () => {
  it("claims 'All N' only when the total provably equals the shown count", () => {
    expect(publishedAnswersNote(512, 512)).toContain("All 512 captured answers");
  });

  it("a capped appendix states shown-of-total, never completeness", () => {
    const note = publishedAnswersNote(400, 512);
    expect(note).toContain("400 of the 512");
    expect(note).not.toMatch(/\ball\b/i);
    expect(note).not.toMatch(/every/i);
  });

  it("legacy snapshots without a total never claim completeness", () => {
    const note = publishedAnswersNote(50, null);
    expect(note).toContain("50 captured answers");
    expect(note).not.toMatch(/\ball\b/i);
    expect(note).not.toMatch(/every/i);
  });
});
