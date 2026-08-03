/**
 * The single commercial-intent value model (spec 038). The audit found two
 * rival models — IntentTier (persisted on prompts, consumed by nothing) and
 * CATEGORY_VALUE (private to the gap detector). This module owns both tables;
 * a third copy is a bug.
 *
 * Tier takes precedence when a prompt has one (tiers are the operator's
 * per-prompt judgment, frozen into snapshots — migration 030); category value
 * is the fallback for untiered prompts. Phase C migrates these constants into
 * the configurable weights mechanism.
 */
import type { IntentTier } from "@/lib/verticals/types";

/** 1 = narrow high-intent (closest to a buying decision) … 4 = broad category. */
export const INTENT_TIER_WEIGHTS: Record<IntentTier, number> = {
  1: 1.0,
  2: 0.8,
  3: 0.6,
  4: 0.4,
};

/**
 * Commercial value per prompt category (documented assumption: high-intent
 * recommendation/problem prompts convert; branded protects; how-to educates).
 * Moved verbatim from lib/gaps/detect.ts — gap scores must not change.
 */
export const CATEGORY_INTENT_VALUE: Record<string, number> = {
  recommendation: 1.0,
  problem: 0.9,
  comparison: 0.8,
  branded: 0.6,
  "how-to": 0.4,
};

export const UNKNOWN_INTENT_WEIGHT = 0.5;

/** Tier when present, category value otherwise. */
export function commercialIntentWeight(prompt: {
  tier?: number | null;
  category?: string | null;
}): number {
  if (prompt.tier === 1 || prompt.tier === 2 || prompt.tier === 3 || prompt.tier === 4) {
    return INTENT_TIER_WEIGHTS[prompt.tier];
  }
  if (prompt.category && prompt.category in CATEGORY_INTENT_VALUE) {
    return CATEGORY_INTENT_VALUE[prompt.category]!;
  }
  return UNKNOWN_INTENT_WEIGHT;
}
