/**
 * Audit page narrative states (spec 123): the hero must tell the story the
 * counts support — zero, low, strong, leader — and fall back to the frozen
 * generator headline on snapshots without a stakes block. Plus the honesty
 * helpers: the one-denominator phrase, the comparison-basis sentence (354
 * is never unlabeled), and the published-answers note (never "all answers"
 * unless provable).
 */
import { describe, expect, it } from "vitest";
import {
  answersTestedPhrase,
  comparisonBasisNote,
  heroHeadline,
  heroOpportunityLine,
  narrativeState,
  publishedAnswersNote,
} from "@/components/audit/narrative";
import { visibilityThreshold } from "@/lib/prospects/constants";

const ctx = {
  prospectName: "The Rivera Team",
  marketName: "Jersey City",
  rivalsCountedAhead: 3,
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
  it("zero: prospect-centric, no universal-absence claim", () => {
    const h = heroHeadline("zero", ctx);
    expect(h).toContain("Jersey City buyers ask AI who to work with");
    expect(h).toContain("isn't being recommended");
    expect(h).not.toMatch(/never/i);
  });

  it("low with several rivals ahead says so — counted, not asserted", () => {
    expect(heroHeadline("low", ctx)).toContain(
      "several local competitors are recommended more often"
    );
  });

  it("low with one rival ahead never claims 'several'", () => {
    const h = heroHeadline("low", { ...ctx, rivalsCountedAhead: 1 });
    expect(h).toContain("another local team is recommended more often");
    expect(h).not.toContain("several");
  });

  it("low with no rival counted ahead falls back to 'rarely the recommendation'", () => {
    const h = heroHeadline("low", { ...ctx, rivalsCountedAhead: 0 });
    expect(h).toContain("rarely the recommendation");
    expect(h).not.toContain("competitors");
  });

  it("strong: acknowledges presence before opportunity", () => {
    const h = heroHeadline("strong", ctx);
    expect(h).toContain("already appears");
    expect(h).toContain("gaps to close");
  });

  it("leader: defend-the-position framing, still benchmark-scoped", () => {
    const h = heroHeadline("leader", ctx);
    expect(h).toContain("leads this benchmark");
    expect(h).toContain("no Jersey City team was recommended more often");
  });

  it("legacy: renders the frozen generator headline verbatim", () => {
    expect(heroHeadline("legacy", ctx)).toBe("Frozen generator headline.");
  });
});

describe("heroOpportunityLine", () => {
  it("zero/low with no dominant rival: the open-space line", () => {
    for (const state of ["zero", "low"] as const) {
      expect(
        heroOpportunityLine(state, {
          marketName: "Jersey City",
          anyRivalDominates: false,
          competitorsWereRecommended: true,
        })
      ).toBe("No Jersey City team dominates these answers yet.");
    }
  });

  it("zero/low with a dominant rival never claims open space", () => {
    const line = heroOpportunityLine("zero", {
      marketName: "Jersey City",
      anyRivalDominates: true,
      competitorsWereRecommended: true,
    });
    expect(line).toContain("recommended instead");
    expect(line).not.toContain("dominates");
  });

  it("zero with nothing counted says nothing — never an invented loss", () => {
    expect(
      heroOpportunityLine("zero", {
        marketName: "Jersey City",
        anyRivalDominates: true,
        competitorsWereRecommended: false,
      })
    ).toBeNull();
  });

  it("leader: defend and strengthen", () => {
    expect(
      heroOpportunityLine("leader", {
        marketName: "Jersey City",
        anyRivalDominates: false,
        competitorsWereRecommended: true,
      })
    ).toContain("defend");
  });

  it("strong: no forced line", () => {
    expect(
      heroOpportunityLine("strong", {
        marketName: "Jersey City",
        anyRivalDominates: true,
        competitorsWereRecommended: true,
      })
    ).toBeNull();
  });
});

describe("answersTestedPhrase — one dominant denominator", () => {
  it("names the consumer counterparts of the tested providers", () => {
    expect(answersTestedPhrase(["openai", "perplexity"], 512)).toBe(
      "the 512 ChatGPT and Perplexity answers we tested"
    );
  });

  it("unknown providers stay neutral, never a guessed brand", () => {
    expect(answersTestedPhrase(["mock"], 512)).toBe(
      "the 512 AI answers we tested"
    );
  });
});

describe("comparisonBasisNote — 354 never unlabeled", () => {
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

  it("a capped appendix states the exact published count, never completeness", () => {
    const note = publishedAnswersNote(400, 512);
    expect(note).toContain("400 published answers");
    expect(note).toContain("of the 512 captured");
    expect(note).not.toMatch(/\ball\b/i);
    expect(note).not.toMatch(/every/i);
  });

  it("legacy snapshots without a total never claim completeness (the 50-answer cap)", () => {
    const note = publishedAnswersNote(50, null);
    expect(note).toContain("50 published answers");
    expect(note).not.toMatch(/\ball\b/i);
    expect(note).not.toMatch(/every/i);
  });
});
