/**
 * EBITDA scenario model (spec 151 C6), pure. EVERY input is a caller-
 * supplied assumption; nothing here is a measured RF figure, and the output
 * says so. Use it to ask "what would have to be true", not to forecast.
 *
 *   clients            = revenue / annual revenue per client
 *   delivery cost      = clients × 12 × (inference + third-party per client-month
 *                        + labor hours per client-month × loaded hourly rate)
 *   gross margin       = (revenue − delivery cost) / revenue
 *   EBITDA             = revenue − delivery cost − fixed operating costs
 *                        (platform infrastructure, sales & marketing, G&A, R&D)
 *
 * Contribution margin (revenue − delivery cost) is NOT EBITDA and is never
 * labelled as such.
 */
export interface ScenarioAssumptions {
  annualRevenueUsd: number;
  annualRevenuePerClientUsd: number;
  inferenceCostPerClientMonthUsd: number;
  thirdPartyCostPerClientMonthUsd: number;
  laborHoursPerClientMonth: number;
  loadedHourlyRateUsd: number;
  fixedPlatformCostPerYearUsd: number;
  salesAndMarketingPerYearUsd: number;
  generalAndAdminPerYearUsd: number;
  researchAndDevelopmentPerYearUsd: number;
}

export interface ScenarioResult {
  label: "hypothetical";
  clients: number;
  deliveryCostUsd: number;
  contributionMarginUsd: number;
  grossMargin: number;
  fixedOperatingCostUsd: number;
  ebitdaUsd: number;
  ebitdaMargin: number;
  /** Max labor hours per client-month that still reaches the target EBITDA
   * margin, holding every other assumption fixed (negative = unreachable
   * even with zero labor). */
  maxLaborHoursForTarget: (targetMargin: number) => number;
}

function assertNonNegative(a: ScenarioAssumptions): void {
  for (const [k, v] of Object.entries(a)) {
    if (!Number.isFinite(v) || v < 0) throw new RangeError(`scenario assumption ${k} must be a finite non-negative number`);
  }
  if (a.annualRevenuePerClientUsd <= 0) throw new RangeError("annualRevenuePerClientUsd must be positive");
}

export function runScenario(a: ScenarioAssumptions): ScenarioResult {
  assertNonNegative(a);
  const clients = a.annualRevenueUsd / a.annualRevenuePerClientUsd;
  const perClientMonth =
    a.inferenceCostPerClientMonthUsd + a.thirdPartyCostPerClientMonthUsd + a.laborHoursPerClientMonth * a.loadedHourlyRateUsd;
  const deliveryCostUsd = clients * 12 * perClientMonth;
  const contributionMarginUsd = a.annualRevenueUsd - deliveryCostUsd;
  const fixedOperatingCostUsd =
    a.fixedPlatformCostPerYearUsd + a.salesAndMarketingPerYearUsd + a.generalAndAdminPerYearUsd + a.researchAndDevelopmentPerYearUsd;
  const ebitdaUsd = contributionMarginUsd - fixedOperatingCostUsd;
  const revenue = a.annualRevenueUsd;
  return {
    label: "hypothetical",
    clients,
    deliveryCostUsd,
    contributionMarginUsd,
    grossMargin: revenue > 0 ? contributionMarginUsd / revenue : 0,
    fixedOperatingCostUsd,
    ebitdaUsd,
    ebitdaMargin: revenue > 0 ? ebitdaUsd / revenue : 0,
    maxLaborHoursForTarget: (target: number) => {
      if (clients === 0 || a.loadedHourlyRateUsd === 0) return Number.POSITIVE_INFINITY;
      const allowedDelivery = revenue * (1 - target) - fixedOperatingCostUsd;
      const nonLabor = clients * 12 * (a.inferenceCostPerClientMonthUsd + a.thirdPartyCostPerClientMonthUsd);
      return (allowedDelivery - nonLabor) / (clients * 12 * a.loadedHourlyRateUsd);
    },
  };
}

/** The four revenue levels the founder asked about, over one assumption set. */
export const SCENARIO_REVENUE_LEVELS_USD = [500_000, 1_000_000, 2_000_000, 3_000_000] as const;

export function scenarioTable(base: Omit<ScenarioAssumptions, "annualRevenueUsd">, targetMargins: number[]) {
  return SCENARIO_REVENUE_LEVELS_USD.map((annualRevenueUsd) => {
    const r = runScenario({ ...base, annualRevenueUsd });
    return {
      annualRevenueUsd,
      clients: r.clients,
      grossMargin: r.grossMargin,
      ebitdaMargin: r.ebitdaMargin,
      maxLaborHours: Object.fromEntries(targetMargins.map((t) => [t, r.maxLaborHoursForTarget(t)])),
      label: r.label,
    };
  });
}
