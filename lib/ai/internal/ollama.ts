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

  let response: Response;

  try {
    response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
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
      `Ollama is unavailable at ${baseUrl}: ${
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
