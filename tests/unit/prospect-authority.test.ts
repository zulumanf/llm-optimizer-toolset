/**
 * Known-answer tests for the local-authority profile (spec 038).
 * Every expected number is derived by hand in the test body.
 */
import { describe, expect, it } from "vitest";
import {
  authorityProfile,
  magnitudeFactor,
  MAGNITUDE_FLOOR,
  PROVENANCE_FACTORS,
  RANK_UNQUANTIFIED_FACTOR,
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

  it("scores a single verified #1 ranking at exactly its kind points", () => {
    const profile = authorityProfile([
      signal({ kind: "ranking", provenance: "verified", valueNumber: 1 }),
    ]);
    // ranking = 15 × 1.0 (rank #1) × 1.0 × 1
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
    // Sales kinds sum to 12+8+4+3+3 = 30 = the cap exactly at verified and
    // magnitude-saturating values (spec 078); nothing can push past 30.
    const profile = authorityProfile([
      signal({ kind: "transaction_volume", valueNumber: 250_000_000 }),
      signal({ kind: "transaction_count", valueNumber: 300 }),
      signal({ kind: "avg_deal_value", valueNumber: 2_500_000 }),
      signal({ kind: "notable_sale" }),
      signal({ kind: "notable_listing" }),
    ]);
    const sales = profile.components.find((c) => c.key === "sales")!;
    expect(sales.points).toBe(30);
    expect(profile.score).toBe(30);
  });

  it("excludes global-scope evidence with a reason instead of discounting it", () => {
    const profile = authorityProfile([
      signal({ kind: "transaction_volume", scope: "global", valueNumber: 250_000_000 }),
      signal({ kind: "ranking", scope: "local", valueNumber: 1 }),
    ]);
    expect(profile.score).toBe(15); // only the local #1 ranking
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
      signal({ kind: "ranking", provenance: "verified", valueNumber: 1 }), // recognition
      signal({ kind: "review_footprint", provenance: "estimated", valueNumber: 100 }), // reputation
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
    // Magnitude-saturating values everywhere a kind has them (spec 078).
    const saturate: Record<string, number> = {
      transaction_volume: 250_000_000,
      transaction_count: 300,
      avg_deal_value: 2_500_000,
      ranking: 1,
      review_footprint: 150,
    };
    const profile = authorityProfile(
      kinds.map((kind) =>
        signal({ kind, provenance: "verified", valueNumber: saturate[kind] ?? null })
      )
    );
    expect(profile.score).toBe(100);
    expect(profile.confidence).toBe(1);
    const discounted = authorityProfile(
      kinds.map((kind) => signal({ kind, provenance: "publicly_sourced" }))
    );
    expect(discounted.score).toBeLessThan(100);
  });
});

describe("magnitudeFactor (spec 078)", () => {
  it("scales volume on a log curve: $1M floor, $10M half, $100M full", () => {
    expect(magnitudeFactor("transaction_volume", 1_000_000)).toBe(MAGNITUDE_FLOOR);
    expect(magnitudeFactor("transaction_volume", 10_000_000)).toBeCloseTo(0.5, 10);
    expect(magnitudeFactor("transaction_volume", 100_000_000)).toBe(1);
    expect(magnitudeFactor("transaction_volume", 219_310_000)).toBe(1);
    // Brian Spain's $23.3M — the live cohort's hand-computed anchor.
    expect(magnitudeFactor("transaction_volume", 23_300_000)).toBeCloseTo(0.6837, 3);
  });

  it("scales counts and reviews on log curves with their own full points", () => {
    expect(magnitudeFactor("transaction_count", 200)).toBe(1);
    expect(magnitudeFactor("transaction_count", 24)).toBeCloseTo(
      Math.log10(24) / Math.log10(200),
      10
    );
    expect(magnitudeFactor("review_footprint", 100)).toBe(1);
    expect(magnitudeFactor("review_footprint", 10)).toBeCloseTo(0.5, 10);
  });

  it("bands rankings best-first and keeps missing rank below every band", () => {
    expect(magnitudeFactor("ranking", 1)).toBe(1);
    expect(magnitudeFactor("ranking", 3)).toBe(0.87);
    expect(magnitudeFactor("ranking", 4)).toBe(0.73);
    expect(magnitudeFactor("ranking", 10)).toBe(0.73);
    expect(magnitudeFactor("ranking", 25)).toBe(0.6);
    expect(magnitudeFactor("ranking", 26)).toBe(RANK_UNQUANTIFIED_FACTOR);
    expect(magnitudeFactor("ranking", null)).toBe(RANK_UNQUANTIFIED_FACTOR);
  });

  it("never lets a missing value outscore a present one", () => {
    for (const kind of [
      "transaction_volume",
      "transaction_count",
      "avg_deal_value",
      "review_footprint",
    ] as const) {
      const missing = magnitudeFactor(kind, null);
      expect(magnitudeFactor(kind, 1)).toBeGreaterThanOrEqual(missing);
      expect(missing).toBe(MAGNITUDE_FLOOR);
    }
  });

  it("is monotonic: a bigger value never scores less", () => {
    const values = [1, 10, 1_000, 1_000_000, 20_000_000, 100_000_000, 1e9];
    for (const kind of ["transaction_volume", "transaction_count", "avg_deal_value"] as const) {
      let prev = 0;
      for (const v of values) {
        const f = magnitudeFactor(kind, v);
        expect(f).toBeGreaterThanOrEqual(prev);
        prev = f;
      }
    }
  });

  it("leaves kinds without magnitude semantics untouched", () => {
    expect(magnitudeFactor("press_mention", null)).toBe(1);
    expect(magnitudeFactor("award", 5)).toBe(1);
    expect(magnitudeFactor("notable_sale", null)).toBe(1);
  });

  it("differentiates the cohort that motivated the spec", () => {
    // Properties by Southern: $219M / 258 sides / #1 vs Brian Spain:
    // $23.3M / 24 sides / #3 — identical under authority-v1 (35 each).
    const pbs = authorityProfile([
      signal({ kind: "transaction_volume", valueNumber: 219_310_000 }),
      signal({ kind: "transaction_count", valueNumber: 258 }),
      signal({ kind: "ranking", valueNumber: 1 }),
    ]);
    const spain = authorityProfile([
      signal({ kind: "transaction_volume", valueNumber: 23_300_000 }),
      signal({ kind: "transaction_count", valueNumber: 24 }),
      signal({ kind: "ranking", valueNumber: 3 }),
    ]);
    expect(pbs.score).toBe(35);
    expect(spain.score).toBeCloseTo(
      12 * 0.6837 + 8 * (Math.log10(24) / Math.log10(200)) + 15 * 0.87,
      1
    );
    expect(pbs.score! - spain.score!).toBeGreaterThan(8);
  });
});
