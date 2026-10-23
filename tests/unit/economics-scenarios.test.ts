import { describe, expect, it } from "vitest";
import { runScenario, scenarioTable, type ScenarioAssumptions } from "@/lib/economics/scenarios";

// Illustrative assumptions only — the test pins arithmetic, not RF's economics.
const base: Omit<ScenarioAssumptions, "annualRevenueUsd"> = {
  annualRevenuePerClientUsd: 12_000,
  inferenceCostPerClientMonthUsd: 20,
  thirdPartyCostPerClientMonthUsd: 30,
  laborHoursPerClientMonth: 2,
  loadedHourlyRateUsd: 75,
  fixedPlatformCostPerYearUsd: 24_000,
  salesAndMarketingPerYearUsd: 100_000,
  generalAndAdminPerYearUsd: 60_000,
  researchAndDevelopmentPerYearUsd: 120_000,
};

describe("runScenario (known answers)", () => {
  it("computes clients, margins and EBITDA", () => {
    const r = runScenario({ ...base, annualRevenueUsd: 1_200_000 });
    expect(r.label).toBe("hypothetical");
    expect(r.clients).toBe(100);
    // per client-month = 20 + 30 + 2×75 = 200 → ×12×100 = 240,000
    expect(r.deliveryCostUsd).toBe(240_000);
    expect(r.grossMargin).toBeCloseTo(0.8, 10);
    expect(r.fixedOperatingCostUsd).toBe(304_000);
    expect(r.ebitdaUsd).toBe(656_000);
    expect(r.ebitdaMargin).toBeCloseTo(656_000 / 1_200_000, 10);
  });
  it("solves the labor ceiling for a target margin, consistent with runScenario", () => {
    const r = runScenario({ ...base, annualRevenueUsd: 1_200_000 });
    const h = r.maxLaborHoursForTarget(0.5);
    const check = runScenario({ ...base, annualRevenueUsd: 1_200_000, laborHoursPerClientMonth: h });
    expect(check.ebitdaMargin).toBeCloseTo(0.5, 10);
  });
  it("reports an unreachable target as a negative labor ceiling", () => {
    const r = runScenario({ ...base, annualRevenueUsd: 100_000 });
    expect(r.maxLaborHoursForTarget(0.5)).toBeLessThan(0);
  });
  it("rejects nonsense inputs", () => {
    expect(() => runScenario({ ...base, annualRevenueUsd: -1 })).toThrow(RangeError);
    expect(() => runScenario({ ...base, annualRevenueUsd: 1, annualRevenuePerClientUsd: 0 })).toThrow(RangeError);
  });
  it("tables the four requested revenue levels", () => {
    const t = scenarioTable(base, [0.5, 0.6]);
    expect(t.map((r) => r.annualRevenueUsd)).toEqual([500_000, 1_000_000, 2_000_000, 3_000_000]);
    expect(t.every((r) => r.label === "hypothetical")).toBe(true);
    expect(t[3]!.maxLaborHours[0.6]!).toBeGreaterThan(t[0]!.maxLaborHours[0.6]!);
  });
});
