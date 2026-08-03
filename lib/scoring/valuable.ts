/**
 * Valuable visibility (spec 038): not every mention is worth the same. A cell
 * (one valid response) earns credit for being mentioned, more for being
 * recommended, more for ranking high — and the cell itself is weighted by the
 * commercial intent of its prompt. Echo is excluded: responses to prompts
 * that named the company measure our question, not the market's answer
 * (the gap detector's organic rule, lib/gaps/detect.ts).
 *
 * Derived on read from current-revision mentions + frozen prompt snapshots;
 * never stored. Null = not measurable, never rendered as 0.
 */
import { commercialIntentWeight } from "@/lib/scoring/intent";

export const VALUABLE_VISIBILITY_VERSION = "valuable-visibility-v1";

/** Cells with at least this intent weight count as high-intent (tier 1–2). */
export const HIGH_INTENT_THRESHOLD = 0.8;

/** Per-cell credit weights. Top-3 uses the first_position_rate convention
 * (docs/06): an unlisted mention simply isn't in that numerator. */
export const CREDIT_WEIGHTS = {
  mentioned: 0.5,
  recommended: 0.35,
  topThree: 0.15,
} as const;

export interface VisibilityCell {
  /** Frozen prompt intent (tier precedence, category fallback). */
  tier: number | null;
  category: string | null;
  /** The prompt text named the company — echo, excluded from every rate. */
  promptNamedCompany: boolean;
  mentioned: boolean;
  recommended: boolean;
  /** 1-indexed list position when the mention sat in a list. */
  listPosition: number | null;
}

export interface ValuableVisibility {
  version: typeof VALUABLE_VISIBILITY_VERSION;
  /** 0–100 intent-weighted visibility credit; null without organic cells. */
  score: number | null;
  weightedMentionRate: number | null;
  weightedRecommendationRate: number | null;
  /** Plain mention rate over high-intent organic cells; null if none exist. */
  highIntentMentionRate: number | null;
  /** Organic sample size — repetitions are cells, so 2 prompts × 3 reps = 6. */
  organicResponses: number;
  /** Cells dropped because the prompt named the company. */
  brandedExcluded: number;
}

export function cellCredit(cell: {
  mentioned: boolean;
  recommended: boolean;
  listPosition: number | null;
}): number {
  if (!cell.mentioned) return 0;
  let credit = CREDIT_WEIGHTS.mentioned;
  if (cell.recommended) credit += CREDIT_WEIGHTS.recommended;
  if (cell.listPosition !== null && cell.listPosition <= 3) credit += CREDIT_WEIGHTS.topThree;
  return credit;
}

export function valuableVisibilityFromCells(cells: VisibilityCell[]): ValuableVisibility {
  const organic = cells.filter((c) => !c.promptNamedCompany);
  const brandedExcluded = cells.length - organic.length;
  if (organic.length === 0) {
    return {
      version: VALUABLE_VISIBILITY_VERSION,
      score: null,
      weightedMentionRate: null,
      weightedRecommendationRate: null,
      highIntentMentionRate: null,
      organicResponses: 0,
      brandedExcluded,
    };
  }

  let weightSum = 0;
  let creditSum = 0;
  let mentionSum = 0;
  let recommendSum = 0;
  let highIntentCells = 0;
  let highIntentMentions = 0;
  for (const cell of organic) {
    const weight = commercialIntentWeight(cell);
    weightSum += weight;
    creditSum += weight * cellCredit(cell);
    mentionSum += weight * (cell.mentioned ? 1 : 0);
    recommendSum += weight * (cell.recommended ? 1 : 0);
    if (weight >= HIGH_INTENT_THRESHOLD) {
      highIntentCells += 1;
      if (cell.mentioned) highIntentMentions += 1;
    }
  }
  // weightSum > 0 always: every weight ≥ UNKNOWN_INTENT_WEIGHT > 0.
  return {
    version: VALUABLE_VISIBILITY_VERSION,
    score: (100 * creditSum) / weightSum,
    weightedMentionRate: mentionSum / weightSum,
    weightedRecommendationRate: recommendSum / weightSum,
    highIntentMentionRate: highIntentCells > 0 ? highIntentMentions / highIntentCells : null,
    organicResponses: organic.length,
    brandedExcluded,
  };
}
