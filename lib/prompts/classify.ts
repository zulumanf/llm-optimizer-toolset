/**
 * Deterministic prompt intent classification (spec 035). Same stance as
 * source classification (DECISIONS 2026-07-31): a wrong rule label is
 * debuggable and fixable in one line; a wrong model label is a mood. A
 * prompt no rule matches returns null — "you tell me", never a guess.
 * Tier mapping mirrors the vertical packs' hand-authored tiers.
 */
import type { PromptCategory } from "@/lib/constants";

export const PROMPT_CLASSIFIER_VERSION = "prompt-classifier-v1+deterministic";

export interface PromptClassification {
  category: PromptCategory;
  tier: 1 | 2 | 3 | 4;
  rule: string;
}

const COMPARISON =
  /\bvs\.?\b|\bversus\b|\bcompare\b|\bcomparison\b|\balternatives? to\b|\bbetter than\b|\binstead of\b/i;
const HOW_TO = /^how (do|to|can|should)\b|\bhow to\b/i;
const RECOMMENDATION = /\bbest\b|\btop \d|\brecommend|\bwhich .{0,40}\bshould (i|we)\b/i;
const PROBLEM =
  /can'?t\b|\bcannot\b|\bstruggl|\bproblem\b|\bissue\b|\bhelp me\b|\bi (need|want) to\b/i;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * First matching rule wins; order is specificity, not preference — "best
 * alternative to X" is a comparison even though it says "best".
 */
export function classifyPrompt(
  text: string,
  opts: { brandNames?: string[] } = {}
): PromptClassification | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;

  for (const name of opts.brandNames ?? []) {
    const clean = name.trim();
    if (clean.length < 2) continue;
    if (new RegExp(`\\b${escapeRegex(clean)}\\b`, "i").test(trimmed)) {
      return { category: "branded", tier: 3, rule: `brand:${clean}` };
    }
  }
  if (COMPARISON.test(trimmed)) {
    return { category: "comparison", tier: 2, rule: "comparison" };
  }
  if (HOW_TO.test(trimmed)) {
    return { category: "how-to", tier: 3, rule: "how-to" };
  }
  if (RECOMMENDATION.test(trimmed)) {
    return { category: "recommendation", tier: 1, rule: "recommendation" };
  }
  if (PROBLEM.test(trimmed)) {
    return { category: "problem", tier: 1, rule: "problem" };
  }
  return null;
}
