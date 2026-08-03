/** Shared named constants (docs/11: no magic numbers, no hardcoded strings). */

export const PROMPT_CATEGORIES = [
  "recommendation",
  "comparison",
  "how-to",
  "branded",
  "problem",
] as const;

export type PromptCategory = (typeof PROMPT_CATEGORIES)[number];

export const PROMPT_TEXT_MAX = 2000;
export const SET_NAME_MAX = 80;
export const SET_DESCRIPTION_MAX = 500;

// Classification & scoring (docs/06 — mirror changes there and in DECISIONS.md)
/** Parser versions. The v1 string is frozen for historical provenance;
 * v2 adds LLM entity resolution (spec 013). The version that actually ran
 * is recorded per row — resolve with lib/parsing/version.ts. */
export const PARSER_VERSION_HEURISTIC = "mention-parser-v1+heuristic";
export const PARSER_VERSION_LLM = "mention-parser-v2+llm";
/** Classification is a narrow judgment on every observation — the mini
 * snapshot keeps per-run cost sane (spec 013). */
export const CLASSIFIER_MODEL = "gpt-5.4-mini-2026-03-17";
/** v1.1 adds stored first_position_rate and top_three_rate (docs/06
 * changelog). Old v1.0 rows are never recomputed — the scores unique key
 * includes scoring_version, so both versions coexist and cross-version
 * comparisons stay forbidden in UI/reports. */
export const SCORING_VERSION = "v1.1";
/**
 * Portfolio-wide provider spend ceiling over a rolling 24h window (plan
 * 2.7). BUDGET_MAX_USD caps one run; nothing capped fifty of them. Checked
 * at run start (fast refusal) and again in the executor (backstop for
 * scheduled runs). Env-overridable for deploys; NaN falls back.
 */
const ceilingFromEnv = Number(process.env.DAILY_SPEND_CEILING_USD);
export const DAILY_SPEND_CEILING_USD = Number.isFinite(ceilingFromEnv)
  ? ceilingFromEnv
  : 25;

export const CONFIDENCE_AUTO_ACCEPT = 0.9;
export const CONFIDENCE_REVIEW_THRESHOLD = 0.7;
export const REVIEW_TIMEOUT_HOURS = 72;

export const SENTIMENTS = ["positive", "neutral", "negative", "mixed"] as const;
export type Sentiment = (typeof SENTIMENTS)[number];
