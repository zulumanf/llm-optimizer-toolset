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
