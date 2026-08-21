/**
 * Cockpit URL state (spec 100). Every filter lives in the query string and
 * every link MERGES the current state with one change — clicking "High
 * intent" must never drop the cohort, the window, or another dimension.
 * Pure, so the composition rule is unit-tested.
 */
export const DASHBOARD_PATH = "/prospects/dashboard";

export type DashboardFilters = {
  /** operate (default) | analyze */
  view?: string;
  /** Analyze: over-time metric and segment dimension. */
  metric?: string;
  segment?: string;
  window?: string;
  launch?: string;
  intent?: string;
  activity?: string;
  outreach?: string;
  sales?: string;
};

export const DASHBOARD_FILTER_KEYS = [
  "view",
  "metric",
  "segment",
  "window",
  "launch",
  "intent",
  "activity",
  "outreach",
  "sales",
] as const satisfies readonly (keyof DashboardFilters)[];

/** `patch` values of `undefined`/"" clear that key; everything else is kept. */
export function dashboardHref(current: DashboardFilters, patch: Partial<DashboardFilters>): string {
  const merged: DashboardFilters = { ...current, ...patch };
  const q = new URLSearchParams();
  for (const key of DASHBOARD_FILTER_KEYS) {
    const v = merged[key];
    if (v) q.set(key, v);
  }
  const s = q.toString();
  return `${DASHBOARD_PATH}${s ? `?${s}` : ""}`;
}
