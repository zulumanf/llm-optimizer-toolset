/**
 * Spec 147 — the global inference bound for profile checks, read from the
 * environment. An invalid value is refused rather than guessed: the dispatcher
 * releases nothing until the operator fixes it, because silently running at a
 * different concurrency is exactly what the bound exists to prevent.
 */
import { ClassifiedError } from "@/lib/errors";
import {
  PROFILE_CHECK_DEFAULT_MAX_INFERENCE_RUNS,
  PROFILE_CHECK_MAX_INFERENCE_RUNS_ENV,
  PROFILE_CHECK_MAX_PROFILES_PER_PROJECT,
} from "@/lib/profile-corrections/constants";

export function profileCheckMaxInferenceRuns(
  env: Record<string, string | undefined> = process.env
): number {
  const raw = env[PROFILE_CHECK_MAX_INFERENCE_RUNS_ENV]?.trim();
  if (raw === undefined || raw === "") return PROFILE_CHECK_DEFAULT_MAX_INFERENCE_RUNS;
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (
    !Number.isInteger(value) ||
    value < 1 ||
    value > PROFILE_CHECK_MAX_PROFILES_PER_PROJECT
  ) {
    throw new ClassifiedError(
      "validation",
      `${PROFILE_CHECK_MAX_INFERENCE_RUNS_ENV} must be an integer from 1 to ${PROFILE_CHECK_MAX_PROFILES_PER_PROJECT}; got "${raw}".`
    );
  }
  return value;
}
