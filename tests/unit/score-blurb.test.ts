/**
 * Spec 084 (verbiage pass): the table blurb is decision-first plain
 * language — track record and AI room-to-grow lead; bookkeeping facts
 * (contact info, timing) appear only when missing; never a model.
 */
import { describe, expect, it } from "vitest";
import { scoreBlurb } from "@/lib/prospects/score-blurb";

describe("scoreBlurb", () => {
  it("leads with track record and AI room; notes gaps; carries the boost", () => {
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
      "Track record 33/100 · room to grow in AI answers 35/100 · recent activity unknown · priority: proven producer, barely recommended by AI"
    );
  });

  it("never presents contact info as a strength — only as a gap", () => {
    const withContact = scoreBlurb({
      components: { commercialAuthority: 20, visibilityGap: 40, contactability: 100 },
    });
    expect(withContact).not.toContain("contact");

    const withoutContact = scoreBlurb({
      components: { commercialAuthority: 20, visibilityGap: 40, contactability: null },
    });
    expect(withoutContact).toContain("no contact info yet");
  });

  it("renders what exists when one anchor is missing", () => {
    const blurb = scoreBlurb({
      components: { visibilityGap: 40, contactability: 100, buyingSignals: 25 },
    });
    expect(blurb).toBe("Room to grow in AI answers 40/100");
  });

  it("returns null for legacy/absent breakdowns and anchor-less components", () => {
    expect(scoreBlurb(null)).toBeNull();
    expect(scoreBlurb(undefined)).toBeNull();
    expect(scoreBlurb({})).toBeNull();
    expect(scoreBlurb({ components: { contactability: 100 } })).toBeNull();
  });
});
