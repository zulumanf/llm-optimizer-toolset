/**
 * The HTTP client every adapter uses.
 *
 * Adapters never call `fetch` directly. Centralising it means timeout, retry,
 * rate-limit accounting, response-size bounds and redaction are properties of
 * the layer rather than of whichever adapter the author remembered to add them
 * to.
 *
 * `Retry-After` is honoured because ignoring it is how an integration gets an
 * account banned rather than throttled.
 */
import { redactSecrets, redactString } from "@/lib/security/envelope";
import { log } from "@/lib/logger";
import type { ConnectorHttpRequest, ConnectorHttpResponse } from "@/lib/connectors/types";

export const DEFAULT_TIMEOUT_MS = 20_000;
export const MAX_RETRIES = 2;
/** Response bodies larger than this are truncated — a provider cannot OOM us. */
export const MAX_RESPONSE_BYTES = 2_000_000;

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  }
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get: (name: string) => string | null; forEach?: (fn: (v: string, k: string) => void) => void };
  text: () => Promise<string>;
}>;

/** Header names worth keeping for diagnostics. Never `authorization`. */
const SAFE_HEADERS = [
  "content-type",
  "retry-after",
  "x-request-id",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
];

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 300);
  const date = Date.parse(value);
  if (Number.isFinite(date)) {
    return Math.max(0, Math.min(300, Math.round((date - Date.now()) / 1000)));
  }
  return null;
}

export interface HttpClientOptions {
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
  provider: string;
  capability?: string;
}

/**
 * Perform one request with bounded retries. A 5xx or a network error is
 * retried; a 4xx is not, because retrying a rejected request just rejects
 * again — the exception is 429, which retries after the provider's own delay.
 */
export async function connectorFetch(
  request: ConnectorHttpRequest,
  options: HttpClientOptions
): Promise<ConnectorHttpResponse> {
  const fetchImpl = (options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)) as FetchLike;
  const method = request.method ?? "GET";
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let body: string | undefined;
  const headers: Record<string, string> = { ...(request.headers ?? {}) };
  if (request.form) {
    body = new URLSearchParams(request.form).toString();
    headers["content-type"] = "application/x-www-form-urlencoded";
  } else if (request.body !== undefined) {
    body = JSON.stringify(request.body);
    headers["content-type"] = headers["content-type"] ?? "application/json";
  }

  let lastResponse: ConnectorHttpResponse | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt += 1) {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(request.url, {
        method,
        headers,
        body,
        signal: controller.signal,
      });
      const raw = await response.text();
      const text = raw.length > MAX_RESPONSE_BYTES ? raw.slice(0, MAX_RESPONSE_BYTES) : raw;
      const latencyMs = Date.now() - started;

      const safeHeaders: Record<string, string> = {};
      for (const name of SAFE_HEADERS) {
        const value = response.headers.get(name);
        if (value !== null) safeHeaders[name] = value;
      }

      let data: unknown = null;
      if (text.length > 0) {
        try {
          data = JSON.parse(text);
        } catch {
          // Not JSON. Keep the (redacted) text; the adapter decides whether
          // that is a failure for this capability.
          data = null;
        }
      }

      const rateLimited = response.status === 429;
      const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"));

      lastResponse = {
        ok: response.ok,
        status: response.status,
        // rawSecrets: the token-refresh exception (see ConnectorHttpRequest)
        // — the credential must reach storeCredential intact; everything
        // else keeps defense-in-depth redaction.
        data: data === null ? null : request.rawSecrets ? data : redactSecrets(data),
        text: redactString(text.slice(0, 2000)),
        headers: safeHeaders,
        latencyMs,
        rateLimited,
        retryAfterSeconds,
      };

      const retryable = rateLimited || response.status >= 500;
      if (!retryable || attempt > MAX_RETRIES) return lastResponse;

      const delayMs = rateLimited && retryAfterSeconds !== null
        ? retryAfterSeconds * 1000
        : 500 * 2 ** (attempt - 1);
      log("warn", "connector.http.retry", {
        provider: options.provider,
        capability: options.capability,
        status: response.status,
        attempt,
        delayMs,
      });
      await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, 30_000)));
    } catch (err) {
      const latencyMs = Date.now() - started;
      const aborted = err instanceof Error && err.name === "AbortError";
      const message = aborted
        ? `request timed out after ${timeoutMs}ms`
        : redactString(err instanceof Error ? err.message : String(err));
      lastResponse = {
        ok: false,
        status: aborted ? 408 : 0,
        data: null,
        text: message,
        headers: {},
        latencyMs,
        rateLimited: false,
        retryAfterSeconds: null,
      };
      if (attempt > MAX_RETRIES) return lastResponse;
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
    } finally {
      clearTimeout(timer);
    }
  }

  return (
    lastResponse ?? {
      ok: false,
      status: 0,
      data: null,
      text: "no response",
      headers: {},
      latencyMs: 0,
      rateLimited: false,
      retryAfterSeconds: null,
    }
  );
}
