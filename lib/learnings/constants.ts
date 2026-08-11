/**
 * Learning vocabulary (spec 058). A separate, dependency-free module so
 * CLIENT components (the record dialog) can import it without dragging the
 * server-only auth chain into the browser bundle — the exact webpack error
 * that broke `next build` when these lived in the service (fix 2026-08-10).
 */
export const LEARNING_CATEGORIES = [
  "content",
  "authority",
  "entity",
  "technical",
  "distribution",
  "process",
  "other",
] as const;
export type LearningCategory = (typeof LEARNING_CATEGORIES)[number];

export const LEARNING_CONFIDENCE_LABELS = [
  "confirmed",
  "strongly_supported",
  "correlated",
  "probable",
  "unknown",
] as const;
export type LearningConfidence = (typeof LEARNING_CONFIDENCE_LABELS)[number];
