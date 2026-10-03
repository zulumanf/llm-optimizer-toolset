/**
 * Spec 147 — profile checks. Named constants for the queue, the dispatcher and
 * the confirmed-URL source. Nothing semantic is spelled inline elsewhere.
 */

/** Most profile URLs checked per project per start (intake allows 20 + website). */
export const PROFILE_CHECK_MAX_PROFILES_PER_PROJECT = 25;

/**
 * Default global bound on inference-active profile runs. One inference host
 * runs gpt-oss:20b extraction then qwen3:30b comparison per check; Spec 146's
 * latency gate only holds without contention. Override with
 * PROFILE_CHECK_MAX_INFERENCE_RUNS (1..PROFILE_CHECK_MAX_PROFILES_PER_PROJECT).
 */
export const PROFILE_CHECK_DEFAULT_MAX_INFERENCE_RUNS = 1;
export const PROFILE_CHECK_MAX_INFERENCE_RUNS_ENV = "PROFILE_CHECK_MAX_INFERENCE_RUNS";

/** A released row with no workflow run after this long is abandoned. */
export const PROFILE_CHECK_RELEASE_TIMEOUT_MINUTES = 15;

/** How soon the dispatcher job re-runs while due work is still queued. */
export const PROFILE_CHECK_DISPATCH_INTERVAL_SECONDS = 60;

/** Transaction-scoped advisory lock: one dispatcher releases at a time. */
export const PROFILE_CHECK_DISPATCH_LOCK_KEY = 727_147_001;

/** Worker job type that runs the dispatcher. */
export const PROFILE_CHECK_DISPATCH_JOB = "profile_check_dispatch";

/** Event that starts one profile-correction run for one released check. */
export const PROFILE_CHECK_REQUESTED_EVENT = "profile.check_requested";

/**
 * Trigger idempotency template on reputation_profile_correction_v1. The run's
 * engine key is `live:` + this, rendered — see profileCheckRunKey.
 */
export const PROFILE_CHECK_IDEMPOTENCY_TEMPLATE =
  "profile-check:{{event.projectId}}:{{payload.checkRequestId}}";

/** The engine prefixes every live run's idempotency key with its mode. */
export const LIVE_RUN_KEY_PREFIX = "live:";

export function profileCheckIdempotencyKey(projectId: string, checkRequestId: string): string {
  return `profile-check:${projectId}:${checkRequestId}`;
}

/** Exactly what workflow_runs.idempotency_key holds for the run a release starts. */
export function profileCheckRunKey(projectId: string, checkRequestId: string): string {
  return `${LIVE_RUN_KEY_PREFIX}${profileCheckIdempotencyKey(projectId, checkRequestId)}`;
}

export const PROFILE_CHECK_ORIGINS = ["operator", "schedule"] as const;
export type ProfileCheckOrigin = (typeof PROFILE_CHECK_ORIGINS)[number];

export const PROFILE_CHECK_KIND = { check: "check", recheck: "recheck" } as const;

export const PROFILE_CHECK_STATUS = {
  queued: "queued",
  released: "released",
  skipped: "skipped",
  failed: "failed",
} as const;

/** Why a confirmed asset row produced no check. */
export const PROFILE_URL_SKIP = {
  noUrl: "no_url",
  invalidUrl: "invalid_url",
  duplicateUrl: "duplicate_url",
  overCap: "over_cap",
} as const;
export type ProfileUrlSkipReason = (typeof PROFILE_URL_SKIP)[keyof typeof PROFILE_URL_SKIP];

/** Why startProfileChecks queued nothing for a URL (or the whole project). */
export const PROFILE_CHECK_SKIP = {
  ...PROFILE_URL_SKIP,
  noConfirmedProfiles: "no_confirmed_profiles",
  alreadyRequested: "already_requested",
  openCorrection: "open_correction",
  queueFailed: "queue_failed",
} as const;
export type ProfileCheckSkipReason = (typeof PROFILE_CHECK_SKIP)[keyof typeof PROFILE_CHECK_SKIP];

/** Why a project was blocked before anything was queued. */
export const PROFILE_CHECK_BLOCK = {
  projectInactive: "project_inactive",
  noLiveEngagement: "no_live_engagement",
  noApprovedFacts: "no_approved_facts",
} as const;
export type ProfileCheckBlockReason = (typeof PROFILE_CHECK_BLOCK)[keyof typeof PROFILE_CHECK_BLOCK];

/** Why the dispatcher closed a row without (or after) releasing it. */
export const PROFILE_CHECK_RELEASE_SKIP = {
  projectInactive: "project_inactive",
  releaseTimedOut: "release_timed_out",
  publishFailed: "publish_failed",
  openCorrection: "open_correction",
} as const;

/**
 * Run states that may still call a local model. Parked (waiting_for_approval)
 * and terminal runs hold no inference and never count against the bound.
 */
export const INFERENCE_ACTIVE_RUN_STATES = [
  "queued",
  "initializing",
  "running",
  "waiting_for_dependency",
  "waiting_for_external_system",
] as const;

/** URL schemes a public profile may use. */
export const PROFILE_URL_PROTOCOLS = ["http:", "https:"] as const;

// ------------------------------------------------------ correction requests

/** Version of the deterministic correction request (spec 147 §5.4). */
export const PROFILE_CORRECTION_REQUEST_VERSION = "profile-correction-request-v1";

export const PROFILE_CORRECTION_STATUS = {
  awaitingApproval: "awaiting_approval",
  approved: "approved",
  destinationRequired: "destination_required",
  awaitingExternalApproval: "awaiting_external_approval",
  readyToDraft: "ready_to_draft",
  awaitingSendConfirmation: "awaiting_send_confirmation",
  sent: "sent",
  rejected: "rejected",
  expired: "expired",
  withdrawn: "withdrawn",
  corrected: "corrected",
  stillIncorrect: "still_incorrect",
  needsReview: "needs_review",
  unreachable: "unreachable",
} as const;

/**
 * A correction in one of these states holds its profile: no second request
 * for the same (project, profile URL) may be created. Mirrors the partial
 * unique index profile_correction_requests_one_open (migration 121).
 */
export const OPEN_CORRECTION_STATUSES = [
  PROFILE_CORRECTION_STATUS.awaitingApproval,
  PROFILE_CORRECTION_STATUS.approved,
  PROFILE_CORRECTION_STATUS.destinationRequired,
  PROFILE_CORRECTION_STATUS.awaitingExternalApproval,
  PROFILE_CORRECTION_STATUS.readyToDraft,
  PROFILE_CORRECTION_STATUS.awaitingSendConfirmation,
  PROFILE_CORRECTION_STATUS.sent,
] as const;

/** Statuses an operator may withdraw from: nothing has left the platform. */
export const WITHDRAWABLE_CORRECTION_STATUSES = [
  PROFILE_CORRECTION_STATUS.awaitingApproval,
  PROFILE_CORRECTION_STATUS.approved,
  PROFILE_CORRECTION_STATUS.destinationRequired,
  PROFILE_CORRECTION_STATUS.awaitingExternalApproval,
  PROFILE_CORRECTION_STATUS.readyToDraft,
  PROFILE_CORRECTION_STATUS.awaitingSendConfirmation,
] as const;

/**
 * Requests whose routing follows the profile's active destination: when the
 * destination is set, replaced or archived, these are routed again. An
 * `approved` request is routed by its own run's route node instead.
 */
export const REROUTABLE_CORRECTION_STATUSES = [
  PROFILE_CORRECTION_STATUS.destinationRequired,
  PROFILE_CORRECTION_STATUS.awaitingExternalApproval,
  PROFILE_CORRECTION_STATUS.readyToDraft,
] as const;

export const DESTINATION_KINDS = ["client_editor", "publisher"] as const;
export type DestinationKind = (typeof DESTINATION_KINDS)[number];

/** The external-submission gate node in the authorization workflow. */
export const EXTERNAL_SUBMISSION_APPROVAL_NODE = "authorize_external";

/** Event that starts the publisher authorization workflow for one destination. */
export const PROFILE_EXTERNAL_APPROVAL_EVENT = "profile.external_approval_required";
export const PROFILE_EXTERNAL_APPROVAL_TEMPLATE =
  "profile-external-approval:{{payload.correctionRequestId}}:{{payload.destinationId}}";
export function profileExternalApprovalKey(correctionRequestId: string, destinationId: string): string {
  return `profile-external-approval:${correctionRequestId}:${destinationId}`;
}

/** The approval gate node in reputation_profile_correction_v1. */
export const PROFILE_CORRECTION_APPROVAL_NODE = "approve";

/** Why a correction request closed without being sent. */
export const PROFILE_CORRECTION_CLOSE = {
  factsChanged: "approved_facts_changed_before_approval",
} as const;

// ---------------------------------------------------------------- drafting

/** Version of the deterministic correction email (spec 147 §7.4). */
export const PROFILE_CORRECTION_EMAIL_VERSION = "profile-correction-email-v1";

/** Days between a confirmed send and the live recheck. */
export const PROFILE_RECHECK_DAYS = 14;

/** The provider that creates real Gmail drafts. Never `fixture`. */
export const PROFILE_DRAFT_PROVIDER = "gmail";

export const PROFILE_DRAFT_STATUS = {
  pending: "pending",
  creating: "creating",
  created: "created",
  sent: "sent",
  failed: "failed",
  superseded: "superseded",
  discarded: "discarded",
  orphaned: "orphaned",
  outcomeUnknown: "outcome_unknown",
} as const;

/** At most one of these per request (unique index, migration 123). */
export const ACTIVE_DRAFT_STATUSES = [
  PROFILE_DRAFT_STATUS.pending,
  PROFILE_DRAFT_STATUS.creating,
  PROFILE_DRAFT_STATUS.created,
] as const;

/** Event that starts one drafting attempt. */
export const PROFILE_CORRECTION_READY_EVENT = "profile.correction_ready";
export const PROFILE_DRAFT_IDEMPOTENCY_TEMPLATE = "profile-correction-draft:{{payload.draftAttemptId}}";
export function profileDraftIdempotencyKey(draftAttemptId: string): string {
  return `profile-correction-draft:${draftAttemptId}`;
}
export function profileDraftRunKey(draftAttemptId: string): string {
  return `${LIVE_RUN_KEY_PREFIX}${profileDraftIdempotencyKey(draftAttemptId)}`;
}

/** Worker job that runs the drafting sweep. */
export const PROFILE_DRAFT_DISPATCH_JOB = "profile_correction_draft_dispatch";
export const PROFILE_DRAFT_DISPATCH_LOCK_KEY = 727_147_002;
/** Ready requests picked up per sweep. */
export const PROFILE_DRAFT_BATCH = 25;
/** A failed attempt is retried automatically only after this long. */
export const PROFILE_DRAFT_RETRY_MINUTES = 360;

/** The human send-confirmation gate in the draft workflow. */
export const SEND_CONFIRMATION_NODE = "confirm_sent";

/** The recheck queue row for a sent correction (spec 147 §9.1). */
export const PROFILE_RECHECK_WINDOW = "recheck";
export function profileRecheckRunKey(correctionRequestId: string): string {
  return `${LIVE_RUN_KEY_PREFIX}profile-recheck:${correctionRequestId}`;
}

// ---------------------------------------------------------------- recheck

/** Event that starts the one recheck run of a sent correction. */
export const PROFILE_RECHECK_DUE_EVENT = "profile.recheck_due";
export const PROFILE_RECHECK_IDEMPOTENCY_TEMPLATE = "profile-recheck:{{payload.correctionRequestId}}";
export function profileRecheckIdempotencyKey(correctionRequestId: string): string {
  return `profile-recheck:${correctionRequestId}`;
}

/** Version of the deterministic recheck result (spec 147 §9.3). */
export const PROFILE_RECHECK_RESULT_VERSION = "profile-recheck-result-v1";

/** How the re-fetched page relates to the before-page evidence. */
export const RECHECK_PAGE_STATE = {
  unreachable: "unreachable",
  unchanged: "unchanged",
  previouslySeen: "previously_seen",
  changed: "changed",
} as const;
export type RecheckPageState = (typeof RECHECK_PAGE_STATE)[keyof typeof RECHECK_PAGE_STATE];

export const RECHECK_RESULT = {
  corrected: "corrected",
  stillIncorrect: "still_incorrect",
  needsReview: "needs_review",
  unreachable: "unreachable",
} as const;
export type RecheckResult = (typeof RECHECK_RESULT)[keyof typeof RECHECK_RESULT];

/** Why the dispatcher closed a recheck row without releasing it. */
export const RECHECK_RELEASE_SKIP = {
  correctionNotSent: "correction_not_sent",
} as const;

// ---------------------------------------------------------- reconciliation

export const PROFILE_RECONCILE_LOCK_KEY = 727_147_003;
/** Requests reconciled per pass, stalest first. */
export const PROFILE_RECONCILE_BATCH = 50;

/**
 * Run states that can never progress again without a human restarting them.
 * `completed` is deliberately absent: a completed run is not a failure, and a
 * request it left in an inconsistent state is reported, not resolved.
 */
export const STOPPED_RUN_STATES = [
  "failed",
  "cancelled",
  "safely_stopped",
  "timed_out",
  "partially_completed",
] as const;

/** Why reconciliation moved a request (audit `detail.reason`). */
export const RECONCILE_REASON = {
  contentApprovalRejected: "content_approval_rejected",
  contentRunStopped: "content_approval_run_stopped",
  routingRunStopped: "approved_request_run_stopped_before_routing",
  externalRunStopped: "external_submission_run_stopped",
  externalRunNeverStarted: "external_submission_run_never_started",
  sendConfirmationStopped: "send_confirmation_run_stopped",
  recheckRunStopped: "recheck_run_stopped_without_result",
  recheckNotReleased: "recheck_could_not_be_released",
} as const;
export type ReconcileReason = (typeof RECONCILE_REASON)[keyof typeof RECONCILE_REASON];
