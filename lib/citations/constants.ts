/**
 * Pure citation-acquisition constants (spec 060) — importable from client
 * components. Nothing here may import a server-only module (the spec-058
 * lesson: a value import of a service chains to db/client and breaks the
 * client bundle at next-build time, invisibly to tests and tsc).
 */

/** Pipeline order; used for forward-only transition validation. */
export const PIPELINE_STATUSES = [
  "discovered",
  "researched",
  "qualified",
  "prioritized",
  "outreach_ready",
  "outreach_in_progress",
  "negotiation",
  "submitted",
  "won",
  "live",
  "verified",
  "measuring",
] as const;
/** Measured endings — only reachable from `measuring`, decided by a human
 * reading the linked intervention's verdicts. */
export const OUTCOME_STATUSES = ["successful", "inconclusive", "no_observed_lift"] as const;
/** Terminal exits — reachable from any non-terminal state. */
export const EXIT_STATUSES = [
  "rejected",
  "not_eligible",
  "not_worth_pursuing",
  "spam_risk",
  "unable_to_contact",
  "lost",
] as const;
export const OPPORTUNITY_STATUSES = [
  ...PIPELINE_STATUSES,
  ...OUTCOME_STATUSES,
  ...EXIT_STATUSES,
] as const;
export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];

export const ACQUISITION_PATHS = [
  "editorial_pitch",
  "guest_contribution",
  "digital_pr",
  "data_story",
  "expert_commentary",
  "directory_listing",
  "review_platform_profile",
  "industry_association",
  "local_media",
  "podcast_guest",
  "partnership_content",
  "sponsored_placement",
  "community_participation",
  "syndication",
  "unknown",
] as const;
export type AcquisitionPath = (typeof ACQUISITION_PATHS)[number];

/**
 * Lifecycle rule (spec 060): forward moves within the pipeline (skips
 * allowed — reality jumps stages), outcomes only from `measuring`, exits
 * from any non-terminal state, terminal states never leave.
 */
export function canTransition(from: OpportunityStatus, to: OpportunityStatus): boolean {
  if (from === to) return false;
  const outcomes = OUTCOME_STATUSES as readonly string[];
  const exits = EXIT_STATUSES as readonly string[];
  if (outcomes.includes(from) || exits.includes(from)) return false;
  if (exits.includes(to)) return true;
  if (outcomes.includes(to)) return from === "measuring";
  const fromIdx = PIPELINE_STATUSES.indexOf(from as (typeof PIPELINE_STATUSES)[number]);
  const toIdx = PIPELINE_STATUSES.indexOf(to as (typeof PIPELINE_STATUSES)[number]);
  return toIdx > fromIdx;
}
