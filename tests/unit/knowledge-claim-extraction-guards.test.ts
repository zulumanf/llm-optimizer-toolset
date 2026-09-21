import { describe, expect, it } from "vitest";

import {
  claimCandidateFingerprint,
  verifyDraft,
  type ProposedClaimDraft,
} from "@/lib/knowledge/extraction/claims";

function draft(
  wording: string,
  overrides: Partial<ProposedClaimDraft> = {}
): ProposedClaimDraft {
  return {
    subject: "Northvale Demo",
    predicate: "is",
    object: "",
    originalWording: wording,
    normalizedWording: wording,
    category: "general",
    asOf: null,
    value: null,
    confidence: 1,
    locator: "",
    ...overrides,
  };
}

describe("canonical claim extraction guards", () => {
  it("detects the same candidate emitted twice", () => {
    const first = claimCandidateFingerprint({
      subject: "Northvale Demo",
      predicate: "offers",
      object: "",
      originalWording:
        "Northvale Demo offers buyer representation and seller representation.",
    });

    const second = claimCandidateFingerprint({
      subject: " northvale   demo ",
      predicate: "OFFERS",
      object: "",
      originalWording:
        "Northvale Demo offers buyer representation and seller representation.",
    });

    expect(first).toBe(second);
  });

  it("preserves distinct objects from the same source passage", () => {
    const buyer = claimCandidateFingerprint({
      subject: "Northvale Demo",
      predicate: "offers",
      object: "buyer representation",
      originalWording:
        "Northvale Demo offers buyer representation and seller representation.",
    });

    const seller = claimCandidateFingerprint({
      subject: "Northvale Demo",
      predicate: "offers",
      object: "seller representation",
      originalWording:
        "Northvale Demo offers buyer representation and seller representation.",
    });

    expect(buyer).not.toBe(seller);
  });

  it("rejects self-promotional best claims", () => {
    const text =
      "We are the best real estate team in New Jersey.";

    expect(
      verifyDraft(
        draft(text, {
          subject: "We",
          predicate: "are the best real estate team",
        }),
        text
      )
    ).toMatchObject({ ok: false });
  });

  it("rejects subjective client-love claims", () => {
    const text =
      "Our clients absolutely love us.";

    expect(
      verifyDraft(
        draft(text, {
          subject: "Our clients",
          predicate: "absolutely love",
        }),
        text
      )
    ).toMatchObject({ ok: false });
  });

  it("rejects expectations and predictions", () => {
    const text =
      "We expect to double our sales next year.";

    expect(
      verifyDraft(
        draft(text, {
          subject: "We",
          predicate: "expect to double",
        }),
        text
      )
    ).toMatchObject({ ok: false });
  });

  it("rejects promotional most-innovative language", () => {
    const text =
      "It is unquestionably the most innovative brokerage in the region.";

    expect(
      verifyDraft(
        draft(text, {
          predicate: "is the most innovative brokerage",
        }),
        text
      )
    ).toMatchObject({ ok: false });
  });

  it("allows an attributed factual ranking", () => {
    const text =
      "RealTrends ranked Northvale Demo #8 among New Jersey real estate teams in 2025.";

    expect(
      verifyDraft(
        draft(text, {
          predicate: "ranked",
          category: "ranking",
          value: 8,
        }),
        text
      )
    ).toEqual({ ok: true });
  });

  it("preserves existing high-risk superlative handling", () => {
    const text =
      "Ana is the leading waterfront agent in Jersey City.";

    expect(
      verifyDraft(
        draft(text, {
          subject: "Ana",
          predicate: "is",
          category: "service",
        }),
        text
      )
    ).toEqual({ ok: true });
  });
});
