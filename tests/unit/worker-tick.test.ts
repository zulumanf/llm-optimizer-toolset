/**
 * The worker's scheduler cadence (2026-08-17): tickDue is the one decision
 * the loop makes about time, so it is pinned here. The tick bodies
 * themselves are the same functions the cron routes run, covered by the
 * automation-layer and cron-route integration suites.
 */
import { describe, expect, it } from "vitest";
import { tickDue } from "@/lib/ops/tick";

const T0 = 1_800_000_000_000;
const TEN_MIN = 10 * 60_000;

describe("tickDue", () => {
  it("fires immediately on a fresh process (no prior tick)", () => {
    expect(tickDue(null, T0, TEN_MIN)).toBe(true);
  });

  it("does not fire before the interval elapses", () => {
    expect(tickDue(T0, T0 + TEN_MIN - 1, TEN_MIN)).toBe(false);
  });

  it("fires exactly at and after the interval", () => {
    expect(tickDue(T0, T0 + TEN_MIN, TEN_MIN)).toBe(true);
    expect(tickDue(T0, T0 + 5 * TEN_MIN, TEN_MIN)).toBe(true);
  });

  it("handles a clock that went backwards by staying quiet", () => {
    expect(tickDue(T0, T0 - 1, TEN_MIN)).toBe(false);
  });
});
