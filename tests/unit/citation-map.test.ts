import { describe, expect, it } from "vitest";
import {
  CITATION_MAP_PIPELINE,
  CITATION_MAP_STATUSES,
  CITATION_MAP_WEIGHTS,
  canTransitionCitationTarget,
  freshnessScore,
  scoreCitationTarget,
} from "@/lib/citations/citation-map";

const asOf = new Date("2026-09-14T00:00:00Z");

describe("citation map scoring", () => {
  it("weights sum to one and Domain Rating is not a component", () => {
    const sum = Object.values(CITATION_MAP_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
    expect(Object.keys(CITATION_MAP_WEIGHTS)).not.toContain("domainRating");
  });

  it("a frequently cited, relevant, fresh, editable news page scores near 100", () => {
    const s = scoreCitationTarget({ answersCiting: 50, maxAnswersCiting: 50, topicRelevance: 1, competitorsPresent: 3, competitorsTracked: 3, sourceClass: "news", publicationDate: new Date("2026-08-01"), insertability: 1, asOf });
    expect(s.score).toBe(100);
    expect(s.explanation.at(-1)).toMatch(/No domain-authority/);
  });

  it("the client's own site is never an opportunity and unknowns are not zeros", () => {
    const own = scoreCitationTarget({ answersCiting: 10, maxAnswersCiting: 10, topicRelevance: 1, competitorsPresent: 0, competitorsTracked: 0, sourceClass: "client_site", publicationDate: null, insertability: 1, asOf });
    expect(own.components.sourceCredibility).toBe(0);
    expect(own.components.freshness).toBe(0.5);
    expect(own.components.competitorPresence).toBe(0);
  });

  it("freshness decays from 1 after 180 days to a 0.2 floor at three years", () => {
    expect(freshnessScore(new Date("2026-06-01"), asOf)).toBe(1);
    expect(freshnessScore(new Date("2020-01-01"), asOf)).toBe(0.2);
    const mid = freshnessScore(new Date("2025-03-01"), asOf);
    expect(mid).toBeGreaterThan(0.2);
    expect(mid).toBeLessThan(1);
  });
});

describe("citation map transitions", () => {
  it("moves forward one stage at a time and exits from any stage except remeasured", () => {
    for (let i = 0; i < CITATION_MAP_PIPELINE.length - 1; i++) {
      expect(canTransitionCitationTarget(CITATION_MAP_PIPELINE[i]!, CITATION_MAP_PIPELINE[i + 1]!)).toBe(true);
    }
    expect(canTransitionCitationTarget("discovered", "live")).toBe(false);
    expect(canTransitionCitationTarget("live", "qualified")).toBe(false);
    expect(canTransitionCitationTarget("pitched", "declined")).toBe(true);
    expect(canTransitionCitationTarget("remeasured", "dropped")).toBe(false);
    expect(CITATION_MAP_STATUSES).toHaveLength(10);
  });
});
