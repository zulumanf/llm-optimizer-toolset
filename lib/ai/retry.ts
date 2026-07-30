/** Retry policy for provider calls (docs/12): exponential backoff with
 * jitter, max 3 attempts, terminal errors fail fast. */
import { ClassifiedError } from "@/lib/errors";

export const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 1000;

export interface ProviderCallError {
  kind:
    | "provider_rate_limit"
    | "provider_quota_exhausted"
    | "provider_auth"
    | "validation"
    | "internal";
  retryable: boolean;
  retryAfterMs?: number;
  message: string;
}

/**
 * A 429 means two very different things, and treating them alike wasted a run.
 *
 * A per-MINUTE limit clears in seconds: wait and retry. A per-DAY quota does
 * not clear today, so every remaining cell is a call that will fail — a Gemini
 * run burned 20 cells against an exhausted daily quota before this existed,
 * producing a partial run and 20 pointless requests.
 *
 * Providers say which in the error body: Google names the quota metric
 * (`...free_tier_requests`) and omits RetryInfo when the window is a day;
 * OpenAI and Anthropic say "quota" or "billing" rather than "rate".
 */
const DAILY_QUOTA_MARKERS = [
  /per\s*day/i,
  /daily\s*(limit|quota)/i,
  /quota\s*exceeded/i,
  /exceeded your current quota/i,
  /check your plan and billing/i,
  /insufficient_quota/i,
  /credit balance is too low/i,
];

/** True when a 429 will still be a 429 in a minute. */
export function isQuotaExhausted(message: string, retryAfterMs?: number): boolean {
  // A provider that tells us when to come back is rate limiting, not refusing.
  if (retryAfterMs !== undefined && retryAfterMs <= 120_000) return false;
  return DAILY_QUOTA_MARKERS.some((pattern) => pattern.test(message));
}

/** Normalize any provider/SDK error into a classified, retry-decidable shape.
 * Auth headers are never included (docs/10: no secrets in logs). */
export function classifyProviderError(err: unknown): ProviderCallError {
  const status =
    typeof err === "object" && err !== null && "status" in err
      ? Number((err as { status: unknown }).status)
      : undefined;
  const message = err instanceof Error ? err.message : "Unknown provider error";

  if (status === 429) {
    const retryAfterHeader =
      typeof err === "object" && err !== null && "headers" in err
        ? (err as { headers?: { get?: (k: string) => string | null } | Record<string, string> })
            .headers
        : undefined;
    let retryAfterMs: number | undefined;
    if (retryAfterHeader) {
      const raw =
        typeof (retryAfterHeader as { get?: unknown }).get === "function"
          ? (retryAfterHeader as { get: (k: string) => string | null }).get("retry-after")
          : (retryAfterHeader as Record<string, string>)["retry-after"];
      const seconds = raw ? Number(raw) : NaN;
      if (Number.isFinite(seconds)) retryAfterMs = seconds * 1000;
    }
    if (isQuotaExhausted(message, retryAfterMs)) {
      // Not retryable, and the caller should stop the whole run rather than
      // work through the remaining cells one failure at a time.
      return { kind: "provider_quota_exhausted", retryable: false, message };
    }
    return { kind: "provider_rate_limit", retryable: true, retryAfterMs, message };
  }
  if (status === 401 || status === 403) {
    return { kind: "provider_auth", retryable: false, message };
  }
  if (status !== undefined && status >= 400 && status < 500) {
    return { kind: "validation", retryable: false, message };
  }
  // 5xx, network, timeouts — retryable
  return { kind: "internal", retryable: true, message };
}

function backoffMs(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) return retryAfterMs;
  const exp = BASE_DELAY_MS * 2 ** (attempt - 1);
  return exp + Math.random() * exp * 0.5;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run a provider call with the docs/12 retry policy. Throws ClassifiedError
 * (carrying the last classification) once terminal or attempts exhausted.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { maxAttempts?: number; sleepFn?: (ms: number) => Promise<unknown> } = {}
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
  const doSleep = opts.sleepFn ?? sleep;
  let lastError: ProviderCallError | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = classifyProviderError(err);
      if (!lastError.retryable || attempt === maxAttempts) {
        throw new ClassifiedError(lastError.kind, lastError.message);
      }
      await doSleep(backoffMs(attempt, lastError.retryAfterMs));
    }
  }
  // Unreachable, but satisfies control-flow analysis
  throw new ClassifiedError("internal", lastError?.message ?? "Retry exhausted");
}
