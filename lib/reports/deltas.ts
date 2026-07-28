/**
 * Change detection (docs/06, deliberately simple v1): a delta on a 0–1 rate
 * metric is NOTABLE when |Δ| ≥ 0.10, N ≥ 30 per side, and the direction is
 * consistent across ≥ 2 providers. Everything else is within noise; small
 * samples are insufficient. Authority (0–100 composite) gets a delta but no
 * noise verdict (null).
 */
export const NOTABLE_DELTA = 0.1;
export const MIN_N_PER_SIDE = 30;

export const RATE_METRICS = new Set([
  "mention_rate",
  "recommendation_rate",
  "share_of_voice",
  "position_score",
  "citation_score",
  "sentiment_index",
]);

export interface ProviderDelta {
  provider: string;
  current: number;
  previous: number;
  nCurrent: number;
  nPrevious: number;
}

export function changeVerdict(
  metric: string,
  aggregate: { current: number; previous: number; nCurrent: number; nPrevious: number },
  perProvider: ProviderDelta[]
): "notable" | "within_noise" | "insufficient" | null {
  if (!RATE_METRICS.has(metric)) return null;
  if (aggregate.nCurrent < MIN_N_PER_SIDE || aggregate.nPrevious < MIN_N_PER_SIDE) {
    return "insufficient";
  }
  const delta = aggregate.current - aggregate.previous;
  if (Math.abs(delta) < NOTABLE_DELTA) return "within_noise";

  const direction = Math.sign(delta);
  const consistent = perProvider.filter(
    (p) => Math.sign(p.current - p.previous) === direction
  ).length;
  return consistent >= 2 ? "notable" : "within_noise";
}
