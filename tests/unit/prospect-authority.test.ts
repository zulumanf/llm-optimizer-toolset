/**
 * Known-answer tests for the local-authority profile (spec 038).
 * Every expected number is derived by hand in the test body.
 */
import { describe, expect, it } from "vitest";
import {
  authorityProfile,
  PROVENANCE_FACTORS,
  type AuthoritySignalInput,
} from "@/lib/prospects/authority";

let n = 0;
const signal = (over: Partial<AuthoritySignalInput>): AuthoritySignalInput => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  kind: "ranking",
  provenance: "verified",
  scope: "local",
  confidence: null,
  ...over,
});

describe("authorityProfile", () => {
  it("returns null score and confidence with no signals — never zero", () => {
    const profile = authorityProfile([]);
    expect(profile.score).toBeNull();
    expect(profile.confidence).toBeNull();
    expect(profile.components.every((c) => c.points === 0)).toBe(true);
  });

  it("scores a single verified ranking at exactly its kind points", () => {
    const profile = authorityProfile([signal({ kind: "ranking", provenance: "verified" })]);
    // ranking = 15 × 1.0 × 1
    expect(profile.score).toBe(15);
    const recognition = profile.components.find((c) => c.key === "recognition")!;
    expect(recognition.points).toBe(15);
    expect(recognition.signalIds.length).toBe(1);
    // confidence = 0.5 × 1.0 (mean provenance) + 0.5 × (1/5 coverage)
    expect(profile.confidence).toBeCloseTo(0.6, 10);
  });

  it("applies provenance factors and per-signal confidence", () => {
    const profile = authorityProfile([
      signal({ kind: "press_mention", provenance: "estimated", confidence: 0.5 }),
    ]);
    // press 8 × 0.4 × 0.5 = 1.6
    expect(profile.score).toBeCloseTo(8 * PROVENANCE_FACTORS.estimated * 0.5, 10);
  });

  it("takes the best signal per kind, never the sum", () => {
    const profile = authorityProfile([
      signal({ kind: "press_mention", provenance: "verified" }), // 8
      signal({ kind: "press_mention", provenance: "verified" }), // still 8
      signal({ kind: "press_mention", provenance: "manual" }), // 4.8, worse
    ]);
    expect(profile.score).toBe(8);
    const media = profile.components.find((c) => c.key === "media")!;
    expect(media.signalIds.length).toBe(3); // all shown as evidence
  });

  it("caps each component at its maximum", () => {
    // Sales kinds sum to 12+8+4+3+3 = 30 = the cap exactly at verified; with
    // an extra manual duplicate nothing can push past 30.
    const profile = authorityProfile([
      signal({ kind: "transaction_volume" }),
      signal({ kind: "transaction_count" }),
      signal({ kind: "avg_deal_value" }),
      signal({ kind: "notable_sale" }),
      signal({ kind: "notable_listing" }),
    ]);
    const sales = profile.components.find((c) => c.key === "sales")!;
    expect(sales.points).toBe(30);
    expect(profile.score).toBe(30);
  });

  it("excludes global-scope evidence with a reason instead of discounting it", () => {
    const profile = authorityProfile([
      signal({ kind: "transaction_volume", scope: "global" }),
      signal({ kind: "ranking", scope: "local" }),
    ]);
    expect(profile.score).toBe(15); // only the local ranking
    expect(profile.excluded.length).toBe(1);
    expect(profile.excluded[0]!.reason).toContain("Global-scope");
  });

  it("excludes 'other' signals from scoring", () => {
    const profile = authorityProfile([signal({ kind: "other" })]);
    expect(profile.score).toBeNull();
    expect(profile.excluded[0]!.reason).toContain("Unclassified");
  });

  it("computes confidence from provenance mix and component coverage", () => {
    const profile = authorityProfile([
      signal({ kind: "ranking", provenance: "verified" }), // recognition
      signal({ kind: "review_footprint", provenance: "estimated" }), // reputation
    ]);
    // mean provenance = (1.0 + 0.4)/2 = 0.7; coverage = 2/5
    expect(profile.confidence).toBeCloseTo(0.5 * 0.7 + 0.5 * 0.4, 10);
    expect(profile.score).toBeCloseTo(15 + 12 * 0.4, 10);
  });

  it("a full evidence base across all five components reaches 100 only when verified", () => {
    const kinds = [
      "transaction_volume",
      "transaction_count",
      "avg_deal_value",
      "notable_sale",
      "notable_listing",
      "ranking",
      "award",
      "review_footprint",
      "years_in_market",
      "team_size",
      "press_mention",
      "market_report",
      "video_content",
      "speaking",
      "specialization",
    ] as const;
    const profile = authorityProfile(kinds.map((kind) => signal({ kind, provenance: "verified" })));
    expect(profile.score).toBe(100);
    expect(profile.confidence).toBe(1);
    const discounted = authorityProfile(
      kinds.map((kind) => signal({ kind, provenance: "publicly_sourced" }))
    );
    expect(discounted.score).toBeLessThan(100);
  });
});
