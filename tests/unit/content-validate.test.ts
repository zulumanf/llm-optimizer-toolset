import { describe, expect, it } from "vitest";
import { validateContent, renderPublishable } from "@/lib/content/validate";

const CLAIM_A = "11111111-2222-4333-8444-555555555555";
const CLAIM_B = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const approved = new Set([CLAIM_A]);
const terms = ["Parva", "parva.io"];

describe("validateContent (the content citation gate)", () => {
  it("fails on claim-level prohibited wording, case-insensitively (D4)", () => {
    const result = validateContent(
      `Parva is the #1 Brokerage in the area [claim:${CLAIM_A}]. Agents juggle many platforms.`,
      terms,
      approved,
      [],
      ["#1 brokerage", "the only luxury specialist"]
    );
    expect(result.ok).toBe(false);
    expect(result.prohibitedWordingHits).toHaveLength(1);
    expect(result.prohibitedWordingHits[0]!.phrase).toBe("#1 brokerage");
    expect(result.prohibitedWordingHits[0]!.sentence).toContain("#1 Brokerage");
  });

  it("passes when prohibited phrases are absent (D4)", () => {
    const result = validateContent(
      `Parva is a link-in-bio tool built for real estate agents [claim:${CLAIM_A}].`,
      terms,
      approved,
      [],
      ["#1 brokerage"]
    );
    expect(result.prohibitedWordingHits).toHaveLength(0);
  });

  it("passes subject sentences with resolvable citations", () => {
    const result = validateContent(
      `Parva is a link-in-bio tool built for real estate agents [claim:${CLAIM_A}]. Agents juggle many platforms.`,
      terms,
      approved
    );
    expect(result.ok).toBe(true);
  });

  it("fails uncited subject sentences", () => {
    const result = validateContent(
      "Parva makes realtors more productive.",
      terms,
      approved
    );
    expect(result.ok).toBe(false);
    expect(result.uncitedSubjectSentences).toHaveLength(1);
  });

  it("fails citations that don't resolve to approved claims", () => {
    const result = validateContent(
      `Parva is great [claim:${CLAIM_B}].`,
      terms,
      approved
    );
    expect(result.ok).toBe(false);
    expect(result.unresolvedCitations).toEqual([`[claim:${CLAIM_B}]`]);
  });

  it("fails invented numbers outside cited sentences", () => {
    const result = validateContent(
      "Over 90% of agents get leads from Instagram.",
      terms,
      approved
    );
    expect(result.ok).toBe(false);
    expect(result.uncitedNumericSentences).toHaveLength(1);
  });

  it("fails uncited superiority claims about the subject", () => {
    const result = validateContent(
      "Parva is the best choice for realtors, obviously.",
      terms,
      approved
    );
    expect(result.uncitedSuperlatives).toHaveLength(1);
  });

  it("ignores headings and general prose without numbers", () => {
    const result = validateContent(
      "## Why link-in-bio matters\nSocial bios allow one link. A hub page fixes that.",
      terms,
      approved
    );
    expect(result.ok).toBe(true);
  });

  it("matches aliases with domain-aware boundaries", () => {
    const result = validateContent("Try parva.io today.", terms, approved);
    expect(result.uncitedSubjectSentences).toHaveLength(1);
  });

  it("accepts citations placed after the sentence period (real GPT habit)", () => {
    const result = validateContent(
      `Parva is a link-in-bio tool built for real estate agents. [claim:${CLAIM_A}]`,
      terms,
      approved
    );
    expect(result.ok).toBe(true);
  });
});

describe("renderPublishable", () => {
  it("strips citation tokens cleanly", () => {
    const out = renderPublishable(
      `Parva is a link-in-bio tool [claim:${CLAIM_A}]. It helps.`
    );
    expect(out).toBe("Parva is a link-in-bio tool. It helps.");
    expect(out).not.toContain("[claim:");
  });
});
