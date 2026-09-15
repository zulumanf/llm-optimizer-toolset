/**
 * Parse-pipeline error types (pipeline hardening 2026-09-14).
 *
 * A required classifier that cannot run is a DEFERRAL, never a downgrade:
 * the job fails with this error, the queue retries it with backoff, and the
 * ledger records `provider_blocked`. Nothing heuristic is written over a
 * classifier judgment while the provider is out.
 */
import { ClassifiedError, type ErrorKind } from "@/lib/errors";
import { providerStateOf, type ProviderState } from "@/lib/ai/provider-state";

const KIND_BY_STATE: Record<ProviderState, ErrorKind> = {
  AVAILABLE: "internal",
  CAPACITY_BLOCKED: "provider_quota_exhausted",
  AUTH_ERROR: "provider_auth",
  RETRYABLE_ERROR: "provider_rate_limit",
  MODEL_UNAVAILABLE: "internal",
};

export class ClassifierUnavailableError extends ClassifiedError {
  readonly providerState: ProviderState;
  readonly cause: unknown;

  constructor(cause: unknown, context: string) {
    const state = providerStateOf(cause);
    const detail = cause instanceof Error ? cause.message : "unknown";
    super(KIND_BY_STATE[state], `Classifier unavailable (${state}) while ${context}; existing evidence preserved, work deferred. ${detail}`);
    this.name = "ClassifierUnavailableError";
    this.providerState = state;
    this.cause = cause;
  }
}

export function isClassifierUnavailable(err: unknown): err is ClassifierUnavailableError {
  return err instanceof ClassifierUnavailableError;
}
