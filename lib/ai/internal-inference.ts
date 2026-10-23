/**
 * Provider-neutral contract for INTERNAL AI work.
 *
 * This is intentionally separate from lib/ai/types.ts:
 *
 * lib/ai/types.ts = external AI systems being MEASURED.
 * This file        = models doing work FOR the platform.
 */
export type InternalInferenceBackend = "openai" | "ollama";

export interface InternalInferenceRequest {
  system: string;
  user: string;
  model?: string;
  /**
   * Optional JSON Schema for constrained structured generation.
   * Backends that support native schema enforcement should use it.
   */
  responseSchema?: Record<string, unknown>;
  /**
   * Reasoning-mode switch for backends that expose one (Ollama `think`);
   * backends without one ignore it. Omitted means the model's default. It
   * changes decoding, so a task may set it only through a reviewed,
   * gold-evaluated route (spec 146A).
   */
  think?: boolean;
}

/** Per-call timing breakdown, when the backend exposes it (spec 146A). */
export interface InternalInferenceTimings {
  loadMs?: number;
  promptEvalMs?: number;
  generationMs?: number;
  /** Length of a separate hidden-reasoning stream, when one is returned. */
  reasoningChars?: number;
}

export interface InternalInferenceResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
  /** Wall/inference duration when the backend exposes it. */
  durationMs?: number;
  timings?: InternalInferenceTimings;
}

export interface InternalInferenceTarget {
  backend: InternalInferenceBackend;
  model: string;
  execution: "paid_api" | "local";
}

export type InternalInferenceCaller = (
  args: InternalInferenceRequest
) => Promise<InternalInferenceResult>;
