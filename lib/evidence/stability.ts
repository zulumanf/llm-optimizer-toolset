/**
 * Deterministic stability labels (evidence spec): for the canonical n=5
 * repeated observations — Established 4–5, Emerging 2–3, Volatile 1,
 * Absent 0. Other sample sizes map by the equivalent proportion; the k/n
 * numerator/denominator is ALWAYS displayed alongside (sample-size
 * differences are never hidden).
 */
export type StabilityLabel = "established" | "emerging" | "volatile" | "absent";

export interface Stability {
  label: StabilityLabel;
  appearances: number;
  observations: number;
}

export function stabilityLabel(appearances: number, observations: number): Stability {
  if (observations <= 0 || appearances < 0 || appearances > observations) {
    throw new Error(`Invalid stability inputs: ${appearances}/${observations}`);
  }
  const ratio = appearances / observations;
  let label: StabilityLabel;
  if (appearances === 0) label = "absent";
  else if (ratio <= 1 / 5 + 1e-9) label = "volatile"; // 1 of 5
  else if (ratio <= 3 / 5 + 1e-9) label = "emerging"; // 2–3 of 5
  else label = "established"; // 4–5 of 5
  return { label, appearances, observations };
}
