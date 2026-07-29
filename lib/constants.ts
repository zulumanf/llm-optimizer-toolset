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
/** @deprecated use activeParserVersion() — kept for historical references */
export const PARSER_VERSION = PARSER_VERSION_HEURISTIC;
/** Classification is a narrow judgment on every observation — the mini
 * snapshot keeps per-run cost sane (spec 013). */
export const CLASSIFIER_MODEL = "gpt-5.4-mini-2026-03-17";
export const SCORING_VERSION = "v1.0";
export const CONFIDENCE_AUTO_ACCEPT = 0.9;
export const CONFIDENCE_REVIEW_THRESHOLD = 0.7;
export const REVIEW_TIMEOUT_HOURS = 72;

export const SENTIMENTS = ["positive", "neutral", "negative", "mixed"] as const;
export type Sentiment = (typeof SENTIMENTS)[number];
