/**
 * Provider availability classification (supply engine preflight, 2026-09-13;
 * moved out of scripts/ 2026-09-14 so the parse pipeline can name the same
 * states). Pure: maps a provider error to an operator-legible state. The
 * parse pipeline treats every non-AVAILABLE state the same way — a required
 * classifier that cannot run defers work, it never downgrades it.
 */
export type ProviderState = "AVAILABLE" | "CAPACITY_BLOCKED" | "AUTH_ERROR" | "RETRYABLE_ERROR" | "MODEL_UNAVAILABLE";

export interface ProviderStatus {
  provider: string;
  state: ProviderState;
  reason: string | null;
  observedAt: string;
  operatorAction: string | null;
}

export const PROVIDER_OPERATOR_ACTIONS: Record<ProviderState, string | null> = {
  AVAILABLE: null,
  CAPACITY_BLOCKED: "Add credits / raise the quota in the provider's billing console (operator only; never automated).",
  AUTH_ERROR: "Check the API key in .env (rotated or revoked).",
  RETRYABLE_ERROR: "Transient — retry later; not a billing problem.",
  MODEL_UNAVAILABLE: "Pinned model id no longer served — update lib/ai pricing/model registry deliberately.",
};

export function classifyProviderError(e: { status?: number; code?: string; message?: string } | null): ProviderState {
  if (!e) return "AVAILABLE";
  const msg = `${e.code ?? ""} ${e.message ?? ""}`.toLowerCase();
  if (e.status === 402 || /credit_balance_exhausted|insufficient_quota|exceeded your current quota/.test(msg)) return "CAPACITY_BLOCKED";
  if (e.status === 401 && !/quota/.test(msg)) return "AUTH_ERROR";
  if (e.status === 401 || e.status === 429) return "CAPACITY_BLOCKED";
  if (e.status === 404 || /model.*not found|does not exist/.test(msg)) return "MODEL_UNAVAILABLE";
  return "RETRYABLE_ERROR";
}

/** State of a thrown classifier error: what the pipeline records on deferral. */
export function providerStateOf(err: unknown): ProviderState {
  if (err instanceof Error) {
    const e = err as Error & { status?: number; code?: string };
    return classifyProviderError({ status: e.status, code: e.code, message: e.message });
  }
  return "RETRYABLE_ERROR";
}
