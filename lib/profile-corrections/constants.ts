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
