/**
 * The configurable-weights mechanism (spec 039) — the ONE place weight sets
 * live. The audit found four independent hardcoded weight tables; new scoring
 * work uses this module, and the legacy constants (AUTHORITY_WEIGHTS, gap
 * factors) migrate here on their next scoring-version bump rather than being
 * silently changed.
 */
import { sql } from "@/db/client";
import { ClassifiedError } from "@/lib/errors";

export interface WeightSet {
  id: string;
  name: string;
  version: number;
  weights: Record<string, number>;
}

const SUM_TOLERANCE = 1e-6;

/** The active weight set for a name. Fails loudly on a bad sum — a weight
 * set that doesn't sum to 1 silently rescales every score it touches. */
export async function getActiveWeightSet(name: string): Promise<WeightSet> {
  const [row] = await sql`
    select id, name, version, weights from scoring_weight_sets
    where name = ${name} and active
  `;
  if (!row) {
    throw new ClassifiedError("not_found", `No active weight set named "${name}".`);
  }
  const weights = row.weights as Record<string, number>;
  const sum = Object.values(weights).reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > SUM_TOLERANCE) {
    throw new ClassifiedError(
      "validation",
      `Weight set "${name}" v${row.version} sums to ${sum}, not 1 — refusing to score with it.`
    );
  }
  return {
    id: row.id as string,
    name: row.name as string,
    version: Number(row.version),
    weights,
  };
}

export interface CompositeResult {
  /** Weighted composite over non-null components; null when all are null. */
  score: number | null;
  /** Components that were null and had their weight redistributed. */
  missing: string[];
}

/**
 * Weighted composite with null-redistribution (the authorityScore
 * convention, docs/06): a component with no data drops out and its weight
 * spreads proportionally over the measured ones. Null only when nothing
 * was measurable.
 */
export function weightedComposite(
  components: Record<string, number | null>,
  weights: Record<string, number>
): CompositeResult {
  const keys = Object.keys(weights);
  const present = keys.filter(
    (k) => components[k] !== null && components[k] !== undefined
  );
  const missing = keys.filter((k) => !present.includes(k));
  if (present.length === 0) return { score: null, missing };
  const totalWeight = present.reduce((acc, k) => acc + weights[k]!, 0);
  if (totalWeight <= 0) return { score: null, missing };
  const score = present.reduce(
    (acc, k) => acc + (components[k] as number) * (weights[k]! / totalWeight),
    0
  );
  return { score, missing };
}
