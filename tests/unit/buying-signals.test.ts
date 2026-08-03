/**
 * Known-answer tests for buying-signal scoring and the freshness helper
 * (spec 042). Time is injected — no Date.now in assertions.
 */
import { describe, expect, it } from "vitest";
import {
  buyingSignalScore,
  recencyFactor,
  SIGNAL_BASE_POINTS,
} from "@/lib/prospects/buying-signals";
import { FRESHNESS_WINDOWS_DAYS, staleness } from "@/lib/prospects/constants";

const NOW = new Date("2026-08-02T00:00:00.000Z");
const daysAgo = (n: number): string => {
  const d = new Date(NOW.getTime() - n * 86_400_000);
  return d.toISOString().slice(0, 10);
};

describe("staleness", () => {
  it("computes age and the window boundary exactly", () => {
    expect(staleness(daysAgo(89), 90, NOW)).toEqual({ ageDays: 89, stale: false });
    expect(staleness(daysAgo(90), 90, NOW)).toEqual({ ageDays: 90, stale: false });
    expect(staleness(daysAgo(91), 90, NOW)).toEqual({ ageDays: 91, stale: true });
  });
});

describe("recencyFactor", () => {
  const window = FRESHNESS_WINDOWS_DAYS.buyingSignal; // 180
  it("full weight inside the window, half to 2×, zero beyond", () => {
    expect(recencyFactor(daysAgo(0), NOW)).toBe(1);
    expect(recencyFactor(daysAgo(window), NOW)).toBe(1);
    expect(recencyFactor(daysAgo(window + 1), NOW)).toBe(0.5);
    expect(recencyFactor(daysAgo(2 * window), NOW)).toBe(0.5);
    expect(recencyFactor(daysAgo(2 * window + 1), NOW)).toBe(0);
  });
});

describe("buyingSignalScore", () => {
  it("is null with no signals — not measured, never fake zero", () => {
    expect(buyingSignalScore([], NOW)).toBeNull();
  });

  it("scores one fresh verified signal at exactly the base points", () => {
    expect(
      buyingSignalScore(
        [{ observedOn: daysAgo(10), provenance: "verified", confidence: null }],
        NOW
      )
    ).toBe(SIGNAL_BASE_POINTS);
  });

  it("applies provenance, per-signal confidence, and recency decay", () => {
    // publicly_sourced (0.85) × confidence 0.5 × aging (0.5) × 25 = 5.3125
    expect(
      buyingSignalScore(
        [
          {
            observedOn: daysAgo(FRESHNESS_WINDOWS_DAYS.buyingSignal + 30),
            provenance: "publicly_sourced",
            confidence: 0.5,
          },
        ],
        NOW
      )
    ).toBeCloseTo(25 * 0.85 * 0.5 * 0.5, 10);
    // Expired signals contribute nothing — but the score is 0, not null:
    // intent was measured and has gone cold.
    expect(
      buyingSignalScore(
        [
          {
            observedOn: daysAgo(2 * FRESHNESS_WINDOWS_DAYS.buyingSignal + 10),
            provenance: "verified",
            confidence: null,
          },
        ],
        NOW
      )
    ).toBe(0);
  });

  it("caps at 100 no matter how many signals stack", () => {
    const fresh = { observedOn: daysAgo(1), provenance: "verified" as const, confidence: null };
    expect(buyingSignalScore(Array.from({ length: 10 }, () => fresh), NOW)).toBe(100);
  });
});
