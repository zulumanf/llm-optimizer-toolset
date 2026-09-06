/**
 * Client engagement vocabulary (spec 131). Client-safe: no DB imports.
 * A signed client's lifecycle continues where the prospect ladder ends
 * (`contracted`); nothing here duplicates a prospect stage.
 */

export const ENGAGEMENT_STAGES = [
  "signed",
  "onboarding",
  "active",
  "renewal_review",
  "renewed",
  "completed",
  "churned",
] as const;
export type EngagementStage = (typeof ENGAGEMENT_STAGES)[number];

/** Stages during which the client is a live commitment. */
export const LIVE_ENGAGEMENT_STAGES: readonly EngagementStage[] = [
  "signed",
  "onboarding",
  "active",
  "renewal_review",
];

export const CONTRACT_STATUSES = ["draft", "sent", "signed", "void"] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

export const BILLING_CADENCES = ["monthly", "upfront", "custom"] as const;
export type BillingCadence = (typeof BILLING_CADENCES)[number];

export const RENEWAL_STATUSES = [
  "not_due",
  "due",
  "offered",
  "renewed",
  "declined",
  "lapsed",
] as const;
export type RenewalStatus = (typeof RENEWAL_STATUSES)[number];

export const MEASUREMENT_ROLES = ["baseline", "midpoint", "final", "adhoc"] as const;
export type MeasurementRole = (typeof MEASUREMENT_ROLES)[number];

export const MEASUREMENT_STATUSES = [
  "planned",
  "frozen",
  "non_comparable",
  "failed",
  "cancelled",
] as const;
export type MeasurementStatus = (typeof MEASUREMENT_STATUSES)[number];

export const CONTEXT_KINDS = [
  "priority_area",
  "property_type",
  "client_focus",
  "excluded_market",
  "competitor",
  "excluded_competitor",
  "identity",
  "asset",
  "access",
  "note",
] as const;
export type ContextKind = (typeof CONTEXT_KINDS)[number];

export const CONTEXT_PROVENANCES = [
  "publicly_observed",
  "client_confirmed",
  "client_priority",
] as const;
export type ContextProvenance = (typeof CONTEXT_PROVENANCES)[number];

export const ACCESS_STATUSES = [
  "requested",
  "granted",
  "not_needed",
  "declined",
  "revoked",
] as const;
export type AccessStatus = (typeof ACCESS_STATUSES)[number];

export const TASK_CONFIDENCE = ["high_confidence", "medium_confidence", "experimental"] as const;
export type TaskConfidence = (typeof TASK_CONFIDENCE)[number];

export const TASK_CONTROL = ["we_control", "client_controls", "third_party"] as const;
export type TaskControl = (typeof TASK_CONTROL)[number];

export const TASK_SCOPE = ["in_scope", "out_of_scope", "needs_founder_review"] as const;
export type TaskScope = (typeof TASK_SCOPE)[number];

export const CLIENT_APPROVAL_STATES = [
  "not_required",
  "required",
  "approved",
  "rejected",
  "edit_requested",
] as const;
export type ClientApprovalState = (typeof CLIENT_APPROVAL_STATES)[number];

/** Approval states in which execution must not start. */
export const CLIENT_APPROVAL_BLOCKS_START: readonly ClientApprovalState[] = [
  "required",
  "rejected",
  "edit_requested",
];

export const BLOCKED_REASONS = [
  "client_access",
  "client_approval",
  "client_input",
  "third_party",
  "internal",
] as const;
export type BlockedReason = (typeof BLOCKED_REASONS)[number];

export const CLIENT_DECISIONS = ["approved", "rejected", "edit_requested"] as const;
export type ClientDecision = (typeof CLIENT_DECISIONS)[number];

export const DECISION_CHANNELS = ["portal", "email", "call", "meeting", "other"] as const;
export type DecisionChannel = (typeof DECISION_CHANNELS)[number];

/** Default initial term. */
export const DEFAULT_TERM_DAYS = 90;
/** Diagnostic remeasurement: same instrument, mid-term. */
export const MIDPOINT_MEASUREMENT_DAY = 45;
/** Formal remeasurement starts this many days before the term ends so the
 * run completes and is reviewed before the renewal conversation. */
export const FINAL_MEASUREMENT_DAYS_BEFORE_END = 10;
/** Renewal review surfaces this many days before the term ends. */
export const RENEWAL_REVIEW_DAYS_BEFORE_END = 21;
/** A former client stays out of cold prospecting for this long after close. */
export const FORMER_CLIENT_COOLDOWN_DAYS = 180;
/** Weekly client update cadence. */
export const CLIENT_UPDATE_CADENCE_DAYS = 7;
/** Version stamped on every measurement snapshot. */
export const MEASUREMENT_METHODOLOGY_VERSION = "engagement-measurement-v1";
/** Entity-resolution policy the snapshot was frozen under (spec 130). */
export const RESOLVER_POLICY_VERSION = "verified-lead-agent-alias-v1";
/** Repetition-total ratio above which two measurements grade `low`. */
export const MEASUREMENT_REPETITION_RATIO_LIMIT = 2;
/** Valid-answer ratio below which two measurements grade `low`. */
export const MEASUREMENT_ANSWER_RATIO_FLOOR = 0.75;
