/**
 * Seeded, reproducible sampling (evidence spec). mulberry32 over a recorded
 * integer seed: anyone with the seed and the same observation set reproduces
 * the exact selection. Audit samples must include, where satisfiable, at
 * least one positive, one negative, and more than one provider.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SampleCandidate {
  id: string;
  positive: boolean;
  provider: string;
}

export interface SampleResult {
  selectedIds: string[];
  constraintsMet: {
    hasPositive: boolean;
    hasNegative: boolean;
    multiProvider: boolean;
    satisfiable: {
      positive: boolean;
      negative: boolean;
      multiProvider: boolean;
    };
  };
}

/** Deterministic shuffle-based selection honoring the audit constraints. */
export function selectAuditSample(
  candidates: SampleCandidate[],
  size: number,
  seed: number
): SampleResult {
  const rng = mulberry32(seed);
  const shuffled = [...candidates].sort(() => 0); // stable base order
  // Fisher–Yates with the seeded rng
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }

  const want = Math.min(size, shuffled.length);
  const picked: SampleCandidate[] = [];
  const pickedIds = new Set<string>();
  const take = (c: SampleCandidate | undefined) => {
    if (c && !pickedIds.has(c.id) && picked.length < want) {
      picked.push(c);
      pickedIds.add(c.id);
    }
  };

  // Constraint seeding first (deterministic order within the shuffle)
  take(shuffled.find((c) => c.positive));
  take(shuffled.find((c) => !c.positive));
  const firstProvider = picked[0]?.provider ?? shuffled[0]?.provider;
  take(shuffled.find((c) => c.provider !== firstProvider));
  for (const c of shuffled) take(c);

  const providers = new Set(picked.map((c) => c.provider));
  const allProviders = new Set(candidates.map((c) => c.provider));
  return {
    selectedIds: picked.map((c) => c.id),
    constraintsMet: {
      hasPositive: picked.some((c) => c.positive),
      hasNegative: picked.some((c) => !c.positive),
      multiProvider: providers.size > 1,
      satisfiable: {
        positive: candidates.some((c) => c.positive),
        negative: candidates.some((c) => !c.positive),
        multiProvider: allProviders.size > 1,
      },
    },
  };
}
