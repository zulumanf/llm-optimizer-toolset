import { OPERATOR_TIMEZONE } from "@/lib/prospects/intent";

/** Render-time formatting only — storage is always timestamptz UTC (docs/11). */
export function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

const OPERATOR_TIME_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: OPERATOR_TIMEZONE,
  timeZoneName: "short",
});

/**
 * Operator-facing timestamp, always in OPERATOR_TIMEZONE with the zone
 * spelled out ("Aug 20, 11:05 AM EDT"). Server components render on a UTC
 * host, so an unzoned toLocaleString silently shows UTC — spec 099.
 */
export function formatOperatorTime(d: Date | string | null | undefined): string {
  if (!d) return "—";
  return OPERATOR_TIME_FORMAT.format(new Date(d));
}

/**
 * Render a 0..1 rate as a percent string. `digits: 0` (default) rounds with
 * Math.round; `digits: 1` uses toFixed(1). null/undefined renders as
 * `nullAs` (default "—") — an unmeasured rate must never print as 0%.
 */
export function formatPercent(
  value: number | null | undefined,
  opts: { digits?: 0 | 1; nullAs?: string } = {}
): string {
  if (value === null || value === undefined) return opts.nullAs ?? "—";
  return opts.digits === 1
    ? `${(value * 100).toFixed(1)}%`
    : `${Math.round(value * 100)}%`;
}

/**
 * Client-facing metric names (spec 051). One vocabulary across the report
 * HTML, the portal, and verdict lines — "recommendation_rate" is ours,
 * "Actively recommended" is theirs.
 */
export const METRIC_LABELS: Record<string, string> = {
  mention_rate: "Mentioned in answers",
  recommendation_rate: "Actively recommended",
  first_position_rate: "Recommended first",
  top_three_rate: "In the top three",
  share_of_voice: "Share of AI voice",
  citation_score: "Own sources cited",
  authority_score: "Authority score",
  position_score: "List position",
  sentiment_index: "Sentiment",
};
