/**
 * Spec 079 unit layer: the missing-fields-only question builder — the
 * structural half of the token-efficiency requirement — and the result
 * schema's tolerance/strictness.
 */
import { describe, expect, it } from "vitest";
import {
  buildEnrichmentQuestion,
  enrichmentResultSchema,
} from "@/lib/prospects/enrichment";

const IDENTITY = {
  businessName: "Rivera Team",
  teamLeader: "Ana Rivera",
  brokerage: "Compass",
  marketName: "Jersey City",
};

describe("buildEnrichmentQuestion", () => {
  it("returns null for a fully-known prospect — the zero-cost path", () => {
    expect(
      buildEnrichmentQuestion(IDENTITY, {
        needEmail: false,
        needVolume: false,
        needSides: false,
        needRank: false,
      })
    ).toBeNull();
  });

  it("asks only for the missing fields", () => {
    const emailOnly = buildEnrichmentQuestion(IDENTITY, {
      needEmail: true,
      needVolume: false,
      needSides: false,
      needRank: false,
    })!;
    expect(emailOnly).toContain("email");
    expect(emailOnly).not.toContain("closed sales volume");

    const productionOnly = buildEnrichmentQuestion(IDENTITY, {
      needEmail: false,
      needVolume: true,
      needSides: true,
      needRank: false,
    })!;
    expect(productionOnly).toContain("closed sales volume");
    expect(productionOnly).toContain("transaction sides");
    expect(productionOnly).not.toContain('"email"');
    expect(productionOnly).not.toContain("rank among");
  });

  it("anchors the question with every identity fact on hand", () => {
    const question = buildEnrichmentQuestion(IDENTITY, {
      needEmail: true,
      needVolume: true,
      needSides: true,
      needRank: true,
    })!;
    for (const anchor of ["Rivera Team", "Ana Rivera", "Compass", "Jersey City"]) {
      expect(question).toContain(anchor);
    }
    expect(question).toContain("No guesses");
  });
});

describe("enrichmentResultSchema", () => {
  it("accepts a nothing-found result — null is a valid answer", () => {
    const parsed = enrichmentResultSchema.safeParse({
      email: null,
      production: null,
      confidence: 0.9,
      notes: "No public email or RealTrends entry found.",
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts a full find and rejects a missing confidence", () => {
    expect(
      enrichmentResultSchema.safeParse({
        email: "ana@riverateam.com",
        emailContactName: "Ana Rivera",
        emailSourceUrl: "https://riverateam.com/contact",
        production: {
          volumeUsd: 23_300_000,
          sides: 24,
          rank: 3,
          rankScope: "Jersey City individuals by volume",
          year: 2026,
          sourceUrl: "https://www.realtrends.com/rankings",
        },
        confidence: 0.8,
        notes: "",
      }).success
    ).toBe(true);
    expect(
      enrichmentResultSchema.safeParse({ email: null, production: null, notes: "" }).success
    ).toBe(false);
  });
});

describe("email validity gate (first-sweep lesson)", () => {
  it("recognizes the Cloudflare placeholder as not-an-email", () => {
    // The staging filter in enrichProspect: syntactically valid but
    // placeholder-flavored strings must not become proposals.
    const valid = (email: string): boolean =>
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && !/protected|example\.com/i.test(email);
    expect(valid("[email protected]")).toBe(false);
    expect(valid("jill@jillbiggsgroup.com")).toBe(true);
    expect(valid("test@example.com")).toBe(false);
    expect(valid("not-an-email")).toBe(false);
  });
});
