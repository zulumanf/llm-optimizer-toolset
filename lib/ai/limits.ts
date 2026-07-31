/**
 * Per-provider rate limits (spec 018 listed fixed provider concurrency as a
 * known gap; this closes it).
 *
 * The gap stopped being theoretical when a 40-prompt Gemini run failed all 40
 * cells in six seconds. The key was valid; the free tier allows five requests
 * per minute and the executor fired four at a time with no pacing. A run that
 * burns its whole prompt set against a rate limit produces no measurement and
 * looks, in the runs list, exactly like a provider outage.
 *
 * Limits are declared per provider rather than inferred from errors, because
 * inferring means learning the limit by breaking it every time.
 */
import type { ProviderId } from "@/lib/ai/types";

export interface ProviderLimits {
  /** Simultaneous in-flight requests for this provider. */
  concurrency: number;
  /**
   * Minimum gap between request *starts*. Rate limits are per minute, so
   * concurrency alone cannot honour them — four parallel workers with no
   * interval will exhaust a 5/min quota in under a second.
   */
  minIntervalMs: number;
  /** Why these numbers, so the next person can tell fact from guess. */
  note: string;
}

const DEFAULT_LIMITS: ProviderLimits = {
  concurrency: 4,
  minIntervalMs: 0,
  note: "Default. No documented constraint applied.",
};

export const PROVIDER_LIMITS: Record<ProviderId, ProviderLimits> = {
  openai: {
    concurrency: 4,
    minIntervalMs: 0,
    note: "Paid tier; 132 real requests across four runs with zero 429s.",
  },
  google: {
    // Measured, not guessed: the API returned
    // "limit: 5, model: gemini-2.5-flash" on
    // GenerateRequestsPerMinutePerProjectPerModel-FreeTier.
    concurrency: 1,
    minIntervalMs: 13_000,
    note: "Gemini free tier is 5 requests/minute per model. 13s ≈ 4.6/min, under the limit with headroom. Raise once billing is enabled.",
  },
  anthropic: {
    concurrency: 2,
    minIntervalMs: 0,
    note: "Untested against a live key; deliberately conservative.",
  },
  perplexity: {
    concurrency: 2,
    minIntervalMs: 0,
    note: "Untested against a live key; deliberately conservative.",
  },
  mock: {
    concurrency: 8,
    minIntervalMs: 0,
    note: "No network. Tests should not wait.",
  },
};

export function limitsFor(provider: string): ProviderLimits {
  return PROVIDER_LIMITS[provider as ProviderId] ?? DEFAULT_LIMITS;
}

/**
 * A gate that spaces request starts per provider.
 *
 * Deliberately shared across workers rather than per-worker: the limit is a
 * property of the provider account, not of a worker, so each worker consulting
 * its own clock would multiply the rate by the worker count — which is exactly
 * how the Gemini run failed.
 */
export function createRateGate(): (provider: string) => Promise<void> {
  const nextAllowedAt = new Map<string, number>();

  return async function waitForSlot(provider: string): Promise<void> {
    const { minIntervalMs } = limitsFor(provider);
    if (minIntervalMs <= 0) return;

    const now = Date.now();
    const earliest = nextAllowedAt.get(provider) ?? 0;
    const start = Math.max(now, earliest);
    // Reserve the slot before awaiting, so concurrent callers queue behind each
    // other instead of all reading the same stale timestamp.
    nextAllowedAt.set(provider, start + minIntervalMs);

    const wait = start - now;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  };
}

/** Effective concurrency for a run, given the providers it uses. */
export function concurrencyFor(providers: string[], ceiling: number): number {
  if (providers.length === 0) return ceiling;
  const lowest = Math.min(...providers.map((p) => limitsFor(p).concurrency));
  return Math.max(1, Math.min(ceiling, lowest));
}
