/** Render-time formatting only — storage is always timestamptz UTC (docs/11). */
export function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
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
