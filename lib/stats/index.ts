/**
 * Measurement statistics (spec 151 A9). Pure, deterministic, dependency-free.
 *
 * The unit of independence is the PROMPT, not the answer: repetitions of one
 * frozen prompt within a run are correlated (same question, same retrieval),
 * so every interval that spans prompts resamples prompts (clusters), never
 * individual answers. Wilson is reported alongside as the naive
 * independent-answers interval — it is the lower bound on honest width.
 *
 * Statistical intervals are NOT classifier confidence. Nothing here reads a
 * classifier's confidence field; callers must keep the two named apart.
 */

/** Two-sided 95% normal quantile. */
export const Z_95 = 1.959963984540054;
/** One-sided 80% power quantile. */
export const Z_POWER_80 = 0.8416212335729143;
/** Bootstrap resamples — enough for stable 2.5/97.5 percentiles at the
 * sample sizes RF runs (≤ a few hundred prompts), cheap in-process. */
export const BOOTSTRAP_ITERATIONS = 2000;
/** Fewer distinct prompts than this and a prompt-clustered bootstrap is
 * not meaningful; the interval is reported as null (insufficient). */
export const MIN_CLUSTERS_FOR_BOOTSTRAP = 5;

export type Interval = readonly [number, number];

/** Wilson score interval for k successes of n (null when n = 0). */
export function wilsonInterval(k: number, n: number, z = Z_95): Interval | null {
  if (n <= 0) return null;
  if (k < 0 || k > n) throw new RangeError(`wilsonInterval: k=${k} outside [0, ${n}]`);
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  // Exact bounds at the extremes (floating-point noise would otherwise
  // report a lower bound of ~1e-19 for 0 successes).
  return [k === 0 ? 0 : Math.max(0, centre - half), k === n ? 1 : Math.min(1, centre + half)];
}

/** mulberry32 — small, fast, seedable PRNG. Reproducibility, not crypto. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable 32-bit seed from a string key (FNV-1a). The same (run, company,
 * metric) key always produces the same bootstrap interval. */
export function seedFromKey(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Per-prompt tally: k successes among n answers to one prompt. */
export interface Cluster {
  k: number;
  n: number;
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const loVal = sorted[lo] as number;
  const hiVal = sorted[hi] as number;
  return loVal + (hiVal - loVal) * (idx - lo);
}

function ratioOfSums(clusters: Cluster[]): number {
  let k = 0;
  let n = 0;
  for (const c of clusters) {
    k += c.k;
    n += c.n;
  }
  return n === 0 ? Number.NaN : k / n;
}

function resample<T>(items: T[], rand: () => number): T[] {
  const out: T[] = new Array(items.length);
  for (let i = 0; i < items.length; i += 1) {
    out[i] = items[Math.floor(rand() * items.length)] as T;
  }
  return out;
}

function percentileInterval(draws: number[]): Interval {
  const finite = draws.filter((d) => Number.isFinite(d)).sort((a, b) => a - b);
  return [percentile(finite, 0.025), percentile(finite, 0.975)];
}

export interface RateEstimate {
  k: number;
  n: number;
  prompts: number;
  rate: number | null;
  wilson: Interval | null;
  /** Prompt-clustered percentile bootstrap; null below MIN_CLUSTERS. */
  clustered: Interval | null;
}

/** A rate with both the naive and the prompt-clustered 95% interval. */
export function estimateRate(
  clusters: Cluster[],
  seed: number,
  iterations = BOOTSTRAP_ITERATIONS
): RateEstimate {
  const live = clusters.filter((c) => c.n > 0);
  const k = live.reduce((a, c) => a + c.k, 0);
  const n = live.reduce((a, c) => a + c.n, 0);
  if (n === 0) {
    return { k: 0, n: 0, prompts: 0, rate: null, wilson: null, clustered: null };
  }
  let clustered: Interval | null = null;
  if (live.length >= MIN_CLUSTERS_FOR_BOOTSTRAP) {
    const rand = seededRandom(seed);
    const draws: number[] = [];
    for (let i = 0; i < iterations; i += 1) draws.push(ratioOfSums(resample(live, rand)));
    clustered = percentileInterval(draws);
  }
  return { k, n, prompts: live.length, rate: k / n, wilson: wilsonInterval(k, n), clustered };
}

/** One prompt measured in two periods. */
export interface PairedCluster {
  promptId: string;
  before: Cluster;
  after: Cluster;
}

export interface DifferenceEstimate {
  estimate: number | null;
  interval: Interval | null;
  prompts: number;
  nBefore: number;
  nAfter: number;
}

/** Pair two per-prompt tallies on shared prompt ids; prompts missing from
 * either side are dropped (a changed panel is not a paired comparison). */
export function pairClusters(
  before: Map<string, Cluster>,
  after: Map<string, Cluster>
): PairedCluster[] {
  const out: PairedCluster[] = [];
  for (const [promptId, b] of before) {
    const a = after.get(promptId);
    if (a && a.n > 0 && b.n > 0) out.push({ promptId, before: b, after: a });
  }
  return out.sort((x, y) => x.promptId.localeCompare(y.promptId));
}

function pairedDelta(pairs: PairedCluster[]): number {
  return ratioOfSums(pairs.map((p) => p.after)) - ratioOfSums(pairs.map((p) => p.before));
}

/** After − before rate over a fixed paired prompt panel, with a bootstrap
 * that resamples PROMPTS (keeping each prompt's before/after together). */
export function pairedDifference(
  pairs: PairedCluster[],
  seed: number,
  iterations = BOOTSTRAP_ITERATIONS
): DifferenceEstimate {
  const nBefore = pairs.reduce((a, p) => a + p.before.n, 0);
  const nAfter = pairs.reduce((a, p) => a + p.after.n, 0);
  if (pairs.length === 0) {
    return { estimate: null, interval: null, prompts: 0, nBefore, nAfter };
  }
  const estimate = pairedDelta(pairs);
  let interval: Interval | null = null;
  if (pairs.length >= MIN_CLUSTERS_FOR_BOOTSTRAP) {
    const rand = seededRandom(seed);
    const draws: number[] = [];
    for (let i = 0; i < iterations; i += 1) draws.push(pairedDelta(resample(pairs, rand)));
    interval = percentileInterval(draws);
  }
  return { estimate, interval, prompts: pairs.length, nBefore, nAfter };
}

export interface DidEstimate {
  estimate: number | null;
  interval: Interval | null;
  treated: DifferenceEstimate;
  control: DifferenceEstimate;
}

/**
 * Difference-in-differences: (Δ treated) − (Δ control), each Δ a paired
 * prompt-level difference. The bootstrap resamples treated and control
 * prompt sets independently. "Control" is whatever the pre-registered plan
 * named (control prompts, or the same prompts for matched control entities);
 * the estimator does not make it causally valid — the design does.
 */
export function differenceInDifferences(
  treated: PairedCluster[],
  control: PairedCluster[],
  seed: number,
  iterations = BOOTSTRAP_ITERATIONS
): DidEstimate {
  const t = pairedDifference(treated, seed, iterations);
  const c = pairedDifference(control, seed ^ 0x9e3779b9, iterations);
  if (t.estimate === null || c.estimate === null) {
    return { estimate: null, interval: null, treated: t, control: c };
  }
  const estimate = t.estimate - c.estimate;
  let interval: Interval | null = null;
  if (treated.length >= MIN_CLUSTERS_FOR_BOOTSTRAP && control.length >= MIN_CLUSTERS_FOR_BOOTSTRAP) {
    const rand = seededRandom(seed ^ 0x85ebca6b);
    const draws: number[] = [];
    for (let i = 0; i < iterations; i += 1) {
      draws.push(pairedDelta(resample(treated, rand)) - pairedDelta(resample(control, rand)));
    }
    interval = percentileInterval(draws);
  }
  return { estimate, interval, treated: t, control: c };
}

/**
 * One-way ANOVA estimator of the intraclass correlation for binary
 * outcomes clustered by prompt. Clamped to [0, 1]; null when it cannot be
 * estimated (fewer than 2 clusters or no within-cluster replication).
 */
export function estimateIcc(clusters: Cluster[]): number | null {
  const live = clusters.filter((c) => c.n > 0);
  const g = live.length;
  const N = live.reduce((a, c) => a + c.n, 0);
  if (g < 2 || N <= g) return null;
  const p = live.reduce((a, c) => a + c.k, 0) / N;
  let ssb = 0;
  let ssw = 0;
  for (const c of live) {
    const pi = c.k / c.n;
    ssb += c.n * (pi - p) ** 2;
    ssw += c.k * (1 - pi) ** 2 + (c.n - c.k) * pi ** 2;
  }
  const msb = ssb / (g - 1);
  const msw = ssw / (N - g);
  const n0 = (N - live.reduce((a, c) => a + c.n * c.n, 0) / N) / (g - 1);
  const denom = msb + (n0 - 1) * msw;
  if (denom <= 0) return 0;
  return Math.min(1, Math.max(0, (msb - msw) / denom));
}

/** Kish design effect for equal cluster size m and intraclass correlation. */
export function designEffect(repetitionsPerPrompt: number, icc: number): number {
  return 1 + (Math.max(1, repetitionsPerPrompt) - 1) * Math.max(0, icc);
}

/**
 * Minimum detectable effect (absolute rate change, two waves, two-sided
 * α = 0.05, 80% power) for a panel of `prompts` × `repetitions` at baseline
 * rate p with intraclass correlation `icc`. Normal approximation for two
 * INDEPENDENT waves: it ignores the gain from pairing prompts and the extra
 * variance of a difference-in-differences (≈ √2 larger). A planning
 * quantity, never a result.
 */
export function minimumDetectableEffect(input: {
  baselineRate: number;
  prompts: number;
  repetitions: number;
  icc: number;
}): number | null {
  const { baselineRate: p, prompts, repetitions, icc } = input;
  if (prompts <= 0 || repetitions <= 0) return null;
  const variance = Math.max(p * (1 - p), 1e-6);
  const nEffective = (prompts * repetitions) / designEffect(repetitions, icc);
  return (Z_95 + Z_POWER_80) * Math.sqrt((2 * variance) / nEffective);
}

/** True when the interval excludes zero (a statistical statement only). */
export function intervalExcludesZero(interval: Interval | null): boolean {
  return interval !== null && (interval[0] > 0 || interval[1] < 0);
}
