/**
 * Ollama backend for INTERNAL inference only.
 *
 * This module must never be registered as an AI visibility measurement
 * provider. It is a worker-brain backend for the platform itself.
 */
import { ClassifiedError } from "@/lib/errors";
import type { ErrorKind } from "@/lib/errors";
import type {
  InternalInferenceCaller,
  InternalInferenceResult,
} from "@/lib/ai/internal-inference";

const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";

interface OllamaChatResponse {
  message?: {
    role?: string;
    content?: string;
    thinking?: string;
  };
  prompt_eval_count?: number;
  eval_count?: number;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_duration?: number;
  eval_duration?: number;
  error?: string;
}

/** The Ollama server this process talks to (`OLLAMA_URL`, else the local default). */
export function ollamaBaseUrl(): string {
  return (process.env.OLLAMA_URL?.trim() || DEFAULT_OLLAMA_URL).replace(/\/+$/, "");
}

/** Spec 158: every chat request is aborted after this long, so a hung or
 * cold-loading server fails closed instead of outliving the engine's own
 * node timeout (300 s for the slowest route) and racing its retry. */
export const OLLAMA_REQUEST_TIMEOUT_MS = 280_000;

const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/;

/**
 * Request headers for the inference host (verbatim from release 151). A
 * HOSTED Ollama — the same open-weight models on a GPU box, keeping the
 * internal-model boundary — must sit behind an authenticating proxy:
 * `OLLAMA_API_KEY` is sent as a bearer token. A key is never sent over plain
 * http to a remote host, and a remote host without a key is refused rather
 * than called unauthenticated.
 */
export function ollamaRequestHeaders(baseUrl = ollamaBaseUrl(), env: Record<string, string | undefined> = process.env): Record<string, string> {
  const url = new URL(baseUrl);
  const local = LOCAL_HOST_RE.test(url.hostname);
  const key = env.OLLAMA_API_KEY?.trim();
  if (!local) {
    if (url.protocol !== "https:") {
      throw new ClassifiedError("internal", "A remote OLLAMA_URL must use https.");
    }
    if (!key) {
      throw new ClassifiedError("internal", "A remote OLLAMA_URL requires OLLAMA_API_KEY (an unauthenticated public inference host is refused).");
    }
  }
  return {
    "content-type": "application/json",
    ...(key ? { authorization: `Bearer ${key}` } : {}),
  };
}

const nsToMs = (ns: number | undefined): number | undefined =>
  typeof ns === "number" ? Math.round(ns / 1_000_000) : undefined;

function errorKindForStatus(status: number): ErrorKind {
  if (status === 401 || status === 403) {
    return "provider_auth";
  }

  if (status === 402) {
    return "provider_quota_exhausted";
  }

  if (status === 429) {
    return "provider_rate_limit";
  }

  return "internal";
}

export const ollamaCaller: InternalInferenceCaller = async ({
  system,
  user,
  model,
  responseSchema,
  think,
}): Promise<InternalInferenceResult> => {
  if (!model || model.trim().length === 0) {
    throw new ClassifiedError(
      "validation",
      "Ollama internal inference requires an explicit model."
    );
  }

  const baseUrl = ollamaBaseUrl();
  // Refuses an unauthenticated or plain-http remote host before any request.
  const headers = ollamaRequestHeaders(baseUrl);

  let response: Response;

  try {
    response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(OLLAMA_REQUEST_TIMEOUT_MS),
      body: JSON.stringify({
        model,
        stream: false,
        format: responseSchema ?? "json",
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        options: {
          temperature: 0,
        },
        // Sent only when a route sets it; otherwise the request is unchanged.
        ...(think === undefined ? {} : { think }),
      }),
    });
  } catch (err) {
    throw new ClassifiedError(
      "internal",
      err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")
        ? `Ollama did not answer within ${OLLAMA_REQUEST_TIMEOUT_MS} ms at ${baseUrl}.`
        : `Ollama is unavailable at ${baseUrl}: ${
            err instanceof Error ? err.message : "unknown connection error"
          }`
    );
  }

  let payload: OllamaChatResponse;

  try {
    payload = (await response.json()) as OllamaChatResponse;
  } catch {
    throw new ClassifiedError(
      "internal",
      `Ollama returned a non-JSON response with HTTP ${response.status}.`
    );
  }

  if (!response.ok || payload.error) {
    throw new ClassifiedError(
      errorKindForStatus(response.status),
      `Ollama request failed for model "${model}" with HTTP ${
        response.status
      }: ${payload.error ?? "unknown Ollama error"}`
    );
  }

  const text = payload.message?.content ?? "";

  if (text.trim().length === 0) {
    throw new ClassifiedError(
      "internal",
      `Ollama model "${model}" returned an empty response.`
    );
  }

  return {
    text,
    tokensIn: payload.prompt_eval_count ?? 0,
    tokensOut: payload.eval_count ?? 0,
    durationMs: nsToMs(payload.total_duration),
    timings: {
      loadMs: nsToMs(payload.load_duration),
      promptEvalMs: nsToMs(payload.prompt_eval_duration),
      generationMs: nsToMs(payload.eval_duration),
      reasoningChars: payload.message?.thinking?.length ?? 0,
    },
  };
};

/** Reachability window for the operator health probe (spec 151 D2). */
export const OLLAMA_HEALTH_TIMEOUT_MS = 2500;

export interface OllamaHealth {
  baseUrl: string;
  reachable: boolean;
  installedModels: string[];
  missingModels: string[];
  error: string | null;
}

/**
 * Is the internal inference host this process would use reachable, and does
 * it hold every model a promoted task routes to? Read-only (`/api/tags`).
 * Promoted tasks FAIL CLOSED when it is not — there is deliberately no
 * proprietary fallback — so this is surfaced to the operator instead.
 */
export async function ollamaHealth(requiredModels: string[]): Promise<OllamaHealth> {
  const baseUrl = ollamaBaseUrl();
  try {
    const res = await fetch(`${baseUrl}/api/tags`, {
      headers: ollamaRequestHeaders(baseUrl),
      signal: AbortSignal.timeout(OLLAMA_HEALTH_TIMEOUT_MS),
    });
    if (!res.ok) return { baseUrl, reachable: false, installedModels: [], missingModels: requiredModels, error: `HTTP ${res.status}` };
    const body = (await res.json()) as { models?: { name?: string; model?: string }[] };
    const installed = (body.models ?? []).map((m) => m.name ?? m.model ?? "").filter(Boolean);
    const missing = requiredModels.filter((r) => !installed.some((i) => i === r || i === `${r}:latest`));
    return { baseUrl, reachable: true, installedModels: installed, missingModels: missing, error: null };
  } catch (err) {
    return { baseUrl, reachable: false, installedModels: [], missingModels: requiredModels, error: err instanceof ClassifiedError ? err.message : err instanceof Error ? err.name : "unknown" };
  }
}
