/**
 * Spec 159: what this process may do, from two opt-in switches. Read at call
 * time (not at import) so a test or a restart with new variables takes
 * effect without a code change. Unset = the safe state on both.
 */

export const AUTOMATION_MODES = ["measurement_only", "full"] as const;
export type AutomationMode = (typeof AUTOMATION_MODES)[number];

export const AUTOMATION_MODE_FLAG = "AUTOMATION_MODE";
export const OUTBOUND_SENDS_FLAG = "OUTBOUND_SENDS_ENABLED";

/**
 * Job types a measurement run needs: capture → parse → score, alias
 * re-parses, and the operator-started analyses of a run. Everything else
 * waits, queued and untouched, until automation is enabled.
 */
export const MEASUREMENT_JOB_TYPES: readonly string[] = [
  "execute_run",
  "parse_response",
  "compute_scores",
  "backfill_company",
  "analyze_gaps",
  "analyze_accuracy",
];

/** Only the exact value "full" enables automation; anything else is measurement only. */
export function automationMode(env: Record<string, string | undefined> = process.env): AutomationMode {
  return env[AUTOMATION_MODE_FLAG]?.trim() === "full" ? "full" : "measurement_only";
}

/** Only the exact string "true" lets anything consequential leave the building. */
export function outboundSendsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[OUTBOUND_SENDS_FLAG] === "true";
}

/** The job types the worker may claim, or null for all (full mode). */
export function claimableJobTypes(env: Record<string, string | undefined> = process.env): readonly string[] | null {
  return automationMode(env) === "full" ? null : MEASUREMENT_JOB_TYPES;
}

export const MEASUREMENT_ONLY_SKIP = { skipped: "measurement_only" } as const;

/** Narrow a gated result: true when the lane was skipped for measurement-only mode. */
export function skippedForMeasurement<T>(r: T | typeof MEASUREMENT_ONLY_SKIP): r is typeof MEASUREMENT_ONLY_SKIP {
  return typeof r === "object" && r !== null && (r as { skipped?: unknown }).skipped === MEASUREMENT_ONLY_SKIP.skipped;
}

export const OUTBOUND_DISABLED_MESSAGE =
  "Outbound sending is switched off (OUTBOUND_SENDS_ENABLED is not \"true\"). Nothing was sent.";
