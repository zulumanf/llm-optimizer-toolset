/**
 * Spec 084: the table blurb is a pure rendering of the stored breakdown —
 * known-answer tested, including the shapes production actually holds.
 */
import { describe, expect, it } from "vitest";
import { scoreBlurb } from "@/lib/prospects/score-blurb";

describe("scoreBlurb", () => {
  it("renders strongest, weakest, missing, and the archetype boost", () => {
    // Brian Spain's real production shape (2026-08-17 recompute).
    const blurb = scoreBlurb({
      components: {
        buyingSignals: null,
        visibilityGap: 35,
        contactability: 100,
        adjustedFixability: 49.06,
        commercialAuthority: 33.05,
        competitorAdvantage: 57.81,
      },
      missing: ["buyingSignals"],
      archetype: "verified_authority_underrepresented",
    });
    expect(blurb).toBe(
      "Strongest: reachability (100) · weakest: verified authority (33) · not yet measured: outreach timing · priority boost: proven producer, barely recommended by AI"
    );
  });

  it("omits sections that do not apply", () => {
    const blurb = scoreBlurb({
      components: { visibilityGap: 40, commercialAuthority: 20 },
      missing: [],
      archetype: null,
    });
    expect(blurb).toBe(
      "Strongest: AI-visibility upside (40) · weakest: verified authority (20)"
    );
  });

  it("returns null for legacy/absent breakdowns and empty components", () => {
    expect(scoreBlurb(null)).toBeNull();
    expect(scoreBlurb(undefined)).toBeNull();
    expect(scoreBlurb({})).toBeNull();
    expect(
      scoreBlurb({ components: { buyingSignals: null }, missing: ["buyingSignals"] })
    ).toBeNull();
  });

  it("falls back to the raw key for unknown components — never drops them", () => {
    const blurb = scoreBlurb({ components: { futureComponent: 50, visibilityGap: 10 } });
    expect(blurb).toContain("futureComponent (50)");
    expect(blurb).toContain("AI-visibility upside (10)");
  });
});
