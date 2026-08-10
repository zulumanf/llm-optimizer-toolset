/**
 * Plain-language verdict lines (spec 051). One translation from measured
 * MetricVerdict-shaped rows to the sentence a nontechnical client reads —
 * used by the portal work tab and the published report so "did it work"
 * has one vocabulary everywhere.
 *
 * Pure function; deliberately conservative wording: "no clear change yet"
 * for noise/insufficient, never "didn't work" — absence of a notable delta
 * at one offset is not a negative result.
 */
import { METRIC_LABELS } from "@/lib/format";

export interface VerdictLike {
  metric: string;
  delta: number;
  verdict: string | null;
}

/** Preference order for the headline metric in a one-line summary. */
const HEADLINE_ORDER = [
  "recommendation_rate",
  "mention_rate",
  "first_position_rate",
  "top_three_rate",
];

function deltaPhrase(metric: string, delta: number): string {
  const label = METRIC_LABELS[metric] ?? metric.replace(/_/g, " ");
  if (metric === "authority_score") {
    return `${label} ${delta >= 0 ? "+" : ""}${delta.toFixed(1)}`;
  }
  const points = delta * 100;
  return `${label} ${points >= 0 ? "+" : ""}${points.toFixed(0)} points`;
}

export function verdictLine(summaries: VerdictLike[]): string {
  if (summaries.length === 0) return "Re-measurement scheduled";
  const notable = summaries.filter((s) => s.verdict === "notable");
  if (notable.length === 0) return "Re-measured — no clear change yet";
  const headline =
    HEADLINE_ORDER.map((m) => notable.find((s) => s.metric === m)).find(Boolean) ??
    notable[0]!;
  const rest = notable.length - 1;
  return `Re-measured: ${deltaPhrase(headline.metric, headline.delta)} (notable)${
    rest > 0 ? ` and ${rest} more notable change${rest === 1 ? "" : "s"}` : ""
  }`;
}
