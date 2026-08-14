/**
 * Intervention lifecycle constants (spec 062) — importable from client
 * components; nothing here may touch a server-only module (the spec-058
 * lesson, same as lib/citations/constants.ts).
 *
 * States are observable facts about the retest experiment, never
 * aspirations: the pre-ship pipeline lives in `tasks` (spec 007), and an
 * intervention exists only once something shipped.
 */

export const LIFECYCLE_VERSION = "intervention-lifecycle-v1";

export const INTERVENTION_STATUSES = [
  "shipped",
  "retest_pending",
  "blocked",
  "retested",
  "cancelled",
] as const;
export type InterventionStatus = (typeof INTERVENTION_STATUSES)[number];

/** `retested` and `cancelled` never leave: the verdicts stand as recorded,
 * and an abandoned measurement stays abandoned on the record. */
export const TERMINAL_STATUSES: readonly InterventionStatus[] = [
  "retested",
  "cancelled",
];

const ALLOWED: Record<InterventionStatus, readonly InterventionStatus[]> = {
  // Forward jumps are allowed (the citation-lifecycle rule): the states are
  // observations, and reality can move faster than the sync that records it.
  shipped: ["retest_pending", "retested", "blocked", "cancelled"],
  // retest_pending → shipped is the one backward move: an operator can empty
  // the retest schedule (updateInterventionSchedule with no offsets), and a
  // row claiming "pending" with nothing queued would be a standing lie.
  retest_pending: ["shipped", "retested", "blocked", "cancelled"],
  // Unblocking resolves to whatever the run history says is true — including
  // straight to retested when a post run completed while the row sat blocked.
  blocked: ["shipped", "retest_pending", "retested", "cancelled"],
  retested: [],
  cancelled: [],
};

export function canTransition(
  from: InterventionStatus,
  to: InterventionStatus
): boolean {
  return ALLOWED[from].includes(to);
}

/**
 * The status the run history supports, independent of what the row says.
 * One derivation shared by the migration backfill (restated in SQL), the
 * heartbeat sync, and the unblock action — never three rival definitions.
 */
export function deriveObservedStatus(history: {
  hasCompletedPost: boolean;
  hasPendingPost: boolean;
}): Extract<InterventionStatus, "shipped" | "retest_pending" | "retested"> {
  if (history.hasCompletedPost) return "retested";
  if (history.hasPendingPost) return "retest_pending";
  return "shipped";
}

/** Statuses an operator may request directly; system-only moves excluded. */
export const OPERATOR_REQUESTABLE: readonly InterventionStatus[] = [
  "blocked",
  "cancelled",
];
