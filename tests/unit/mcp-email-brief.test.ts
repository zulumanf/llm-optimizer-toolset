/**
 * Unit tests for the email-brief composer (spec 126) — the payload an
 * external drafting agent must be able to trust blindly. The no-capture
 * path is the safety-critical one: no measurement claim, no implied
 * absence, and every generated line passes the prohibited-phrases gate.
 */
import { describe, expect, it } from "vitest";
import { buildEmailBrief } from "@/lib/mcp/email-brief";
import { findProhibitedPhrase } from "@/lib/prospects/constants";

const base = { teamName: "Rivera Team", marketName: "Manhattan" };

const capture = {
  validAnswers: 48,
  mentionedCount: 6,
  recommendedCount: 0,
  competitorsNamed: ["Acme", "Baker Group", "Cole & Co", "Dune Realty"],
  topDomain: { domain: "zillow.com", citations: 31 },
  teamDomainCitations: 2,
  teamWebsiteDomain: "riverateam.com",
};

describe("buildEmailBrief", () => {
  it("refuses measurement claims when there is no capture", () => {
    const brief = buildEmailBrief({ ...base, capture: null });
    expect(brief.allowed_to_claim_measurement).toBe(false);
    expect(brief.valid_answers).toBe(0);
    expect(brief.recommended_count).toBe(0);
    expect(brief.competitors_named).toEqual([]);
    // The fallback line must not claim the team was measured or missing.
    expect(brief.allowed_first_line).not.toMatch(/Rivera Team/);
    expect(brief.allowed_first_line).not.toMatch(/did not appear|missing|absent/i);
    expect(brief.do_not_say.join(" ")).toMatch(/missing from ChatGPT/);
  });

  it("treats a zero-answer capture as no capture", () => {
    const brief = buildEmailBrief({
      ...base,
      capture: { ...capture, validAnswers: 0 },
    });
    expect(brief.allowed_to_claim_measurement).toBe(false);
  });

  it("states counted mentions without recommendation", () => {
    const brief = buildEmailBrief({ ...base, capture });
    expect(brief.allowed_to_claim_measurement).toBe(true);
    expect(brief.appeared).toBe(true);
    expect(brief.recommended).toBe(false);
    expect(brief.allowed_first_line).toContain("48 AI answers");
    expect(brief.allowed_first_line).toContain("Rivera Team");
  });

  it("states counted recommendations", () => {
    const brief = buildEmailBrief({
      ...base,
      capture: { ...capture, recommendedCount: 9 },
    });
    expect(brief.recommended).toBe(true);
    expect(brief.allowed_first_line).toContain("recommended in 9");
  });

  it("states counted absence only from a real capture", () => {
    const brief = buildEmailBrief({
      ...base,
      capture: { ...capture, mentionedCount: 0, recommendedCount: 0 },
    });
    expect(brief.appeared).toBe(false);
    expect(brief.allowed_first_line).toContain("did not appear");
    expect(brief.allowed_first_line).toContain("48");
  });

  it("caps competitors at three, from real data order", () => {
    const brief = buildEmailBrief({ ...base, capture });
    expect(brief.competitors_named).toEqual(["Acme", "Baker Group", "Cole & Co"]);
  });

  it("derives the one-source gap only when a foreign domain out-cites the team site", () => {
    expect(buildEmailBrief({ ...base, capture }).one_source_gap).toContain("zillow.com");
    expect(
      buildEmailBrief({
        ...base,
        capture: { ...capture, topDomain: { domain: "riverateam.com", citations: 31 } },
      }).one_source_gap
    ).toBeNull();
    expect(
      buildEmailBrief({
        ...base,
        capture: { ...capture, teamDomainCitations: 40 },
      }).one_source_gap
    ).toBeNull();
  });

  it("every generated line passes the prohibited-phrases gate", () => {
    const variants = [
      buildEmailBrief({ ...base, capture: null }),
      buildEmailBrief({ ...base, capture }),
      buildEmailBrief({ ...base, capture: { ...capture, recommendedCount: 9 } }),
      buildEmailBrief({ ...base, capture: { ...capture, mentionedCount: 0 } }),
    ];
    for (const brief of variants) {
      expect(findProhibitedPhrase(brief.allowed_first_line)).toBeNull();
      if (brief.one_source_gap) {
        expect(findProhibitedPhrase(brief.one_source_gap)).toBeNull();
      }
    }
  });
});
