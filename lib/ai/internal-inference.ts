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
}

export interface InternalInferenceResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
  /** Wall/inference duration when the backend exposes it. */
  durationMs?: number;
}

export interface InternalInferenceTarget {
  backend: InternalInferenceBackend;
  model: string;
  execution: "paid_api" | "local";
}

export type InternalInferenceCaller = (
  args: InternalInferenceRequest
) => Promise<InternalInferenceResult>;
