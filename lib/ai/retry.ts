/** Retry policy for provider calls (docs/12): exponential backoff with
 * jitter, max 3 attempts, terminal errors fail fast. */
import { ClassifiedError } from "@/lib/errors";

export const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 1000;

export interface ProviderCallError {
  kind: "provider_rate_limit" | "provider_auth" | "validation" | "internal";
  retryable: boolean;
  retryAfterMs?: number;
  message: string;
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
