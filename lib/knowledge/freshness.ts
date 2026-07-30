/**
 * Claim freshness (spec 020 Phase 2).
 *
 * Every claim resolves to exactly one of six states. There is no "probably
 * fine", and `unknown` is deliberately not optimistic: a sales-volume figure
 * with no as-of date cannot be stated as current, so the platform refuses to
 * let an agent try.
 *
 * Pure functions — no database, no clock of its own. `now` is a parameter so a
 * test can assert the boundary rather than sleep through it.
 *
 * Prose version: docs/operations/knowledge-freshness-and-provenance.md
 */
import {
  CATEGORIES_REQUIRING_AS_OF,
  DEFAULT_REVIEW_WINDOW_DAYS,
  FRESHNESS_SEVERITY,
  NEARING_REVIEW_FRACTION,
  REVIEW_WINDOW_DAYS,
  TIME_BOUNDED_CATEGORIES,
  type FreshnessState,
} from "@/lib/knowledge/constants";

const DAY_MS = 86_400_000;

export interface FreshnessInput {
  category: string;
  status?: string;
  /** The date the claim is true *about*. */
  asOf?: string | Date | null;
  effectiveDate?: string | Date | null;
  /** An explicit review deadline, when one was set. */
  reviewDate?: string | Date | null;
  lastVerifiedAt?: string | Date | null;
  verificationStatus?: string | null;
}

export interface FreshnessAssessment {
  state: FreshnessState;
  /** Why, in one line an operator can act on. */
  reason: string;
  /** Days until review, negative once overdue; null when there is no window. */
  daysUntilReview: number | null;
  reviewWindowDays: number;
  /** True when this claim must not enter a high-risk packet. */
  blocksHighRisk: boolean;
}

/** Days in the review window for a category. 0 means "does not decay". */
export function reviewWindowDays(category: string): number {
  return REVIEW_WINDOW_DAYS[category] ?? DEFAULT_REVIEW_WINDOW_DAYS;
}

export function assessFreshness(
  input: FreshnessInput,
  now: Date = new Date()
): FreshnessAssessment {
  const window = reviewWindowDays(input.category);

  // A superseded claim is not stale — a newer version exists and is used
  // instead. Distinguishing the two matters: one needs work, the other does not.
  if (input.status === "superseded") {
    return assessment("superseded", "A newer approved version replaces this claim.", null, window);
  }
  if (input.verificationStatus === "expired") {
    return assessment("expired", "The claim was marked expired during verification.", null, window);
  }

  const anchor = toDate(input.asOf) ?? toDate(input.effectiveDate);

  // Categories whose value is meaningless without a date: no date, no use.
  if (!anchor && CATEGORIES_REQUIRING_AS_OF.includes(input.category)) {
    return assessment(
      "unknown",
      `A ${input.category.replace(/_/g, " ")} claim carries no as-of date, so it cannot be stated as current.`,
      null,
      window
    );
  }

  // Time-bounded claims are true *about* their period. A 2024 ranking in 2026
  // is expired, not stale — restating it as current is the classic overclaim.
  if (anchor && TIME_BOUNDED_CATEGORIES.includes(input.category)) {
    const periodEnd = new Date(anchor);
    periodEnd.setUTCFullYear(periodEnd.getUTCFullYear() + 1);
    if (now >= periodEnd) {
      return assessment(
        "expired",
        `This ${input.category.replace(/_/g, " ")} is true about ${isoDate(anchor)} and its period has ended.`,
        daysBetween(now, periodEnd),
        window
      );
    }
  }

  // An explicit review date always wins over the category default: someone
  // made a deliberate decision about this claim.
  const explicitReview = toDate(input.reviewDate);
  if (explicitReview) {
    const days = daysBetween(now, explicitReview);
    if (days < 0) {
      return assessment(
        "stale",
        `Past its review date (${isoDate(explicitReview)}) by ${Math.abs(days)} days.`,
        days,
        window
      );
    }
    return withinWindow(days, window, `Reviewed through ${isoDate(explicitReview)}.`);
  }

  // No window means the fact does not decay — a closed transaction, once
  // verified, is not less true next year.
  if (window === 0) {
    if (input.verificationStatus && input.verificationStatus !== "verified") {
      return assessment(
        "unknown",
        "This claim does not decay, but it has not been verified yet.",
        null,
        window
      );
    }
    return assessment("current", "This claim does not decay once verified.", null, window);
  }

  const verified = toDate(input.lastVerifiedAt) ?? anchor;
  if (!verified) {
    return assessment(
      "unknown",
      "No as-of, effective or verification date is recorded, so freshness cannot be determined.",
      null,
      window
    );
  }

  const dueDate = new Date(verified.getTime() + window * DAY_MS);
  const days = daysBetween(now, dueDate);
  if (days < 0) {
    return assessment(
      "stale",
      `Last confirmed ${isoDate(verified)}; the ${window}-day review window closed ${Math.abs(days)} days ago.`,
      days,
      window
    );
  }
  return withinWindow(days, window, `Last confirmed ${isoDate(verified)}.`);
}

function withinWindow(days: number, window: number, prefix: string): FreshnessAssessment {
  if (days <= window * NEARING_REVIEW_FRACTION) {
    return assessment(
      "nearing_review",
      `${prefix} Due for review in ${days} days.`,
      days,
      window
    );
  }
  return assessment("current", `${prefix} Next review in ${days} days.`, days, window);
}

function assessment(
  state: FreshnessState,
  reason: string,
  daysUntilReview: number | null,
  reviewWindow: number
): FreshnessAssessment {
  return {
    state,
    reason,
    daysUntilReview,
    reviewWindowDays: reviewWindow,
    blocksHighRisk: BLOCKS_HIGH_RISK.has(state),
  };
}

/** States that must not silently enter a high-risk context packet. */
const BLOCKS_HIGH_RISK = new Set<FreshnessState>(["stale", "expired", "unknown"]);

export function blocksHighRisk(state: FreshnessState): boolean {
  return BLOCKS_HIGH_RISK.has(state);
}

/**
 * Roll several states into one. A page or packet is only as fresh as its worst
 * dependency — one expired ranking makes the whole page read as expired rather
 * than hiding inside it.
 */
export function worstFreshness(states: FreshnessState[]): FreshnessState {
  if (states.length === 0) return "current";
  return states.reduce((worst, state) =>
    FRESHNESS_SEVERITY[state] > FRESHNESS_SEVERITY[worst] ? state : worst
  );
}

function toDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`; negative once `to` is in the past. */
function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / DAY_MS);
}
