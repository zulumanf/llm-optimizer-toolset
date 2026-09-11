/**
 * The two sample-size confidence curves, co-located (cleanup-3). Both are
 * pure and monotonic in n; callers keep their own floors and caps.
 *
 * - `logSampleConfidence`: the diagnosis/findings curve — 0.4 at n=1, ~0.9 by
 *   n≈40, capped at 0.95. Used where a sampled rate backs a stated claim.
 * - `bandedSampleConfidence`: the gap-detection bands — 0.5 / 0.7 / 0.9 at
 *   n < 10 / ≥ 10 / ≥ 30. Used where a coarse label is all the evidence
 *   supports.
 *
 * Never inferred from anything but the count of sampled answers.
 */
export function logSampleConfidence(n: number): number {
  return Math.min(0.95, 0.4 + Math.log10(Math.max(1, n)) * 0.32);
}

export function bandedSampleConfidence(n: number): number {
  if (n >= 30) return 0.9;
  if (n >= 10) return 0.7;
  return 0.5;
}
