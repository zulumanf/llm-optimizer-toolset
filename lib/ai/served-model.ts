/**
 * Served-model identity (spec 151 A1). Providers report the model that
 * actually answered, which can differ from the requested id (aliases,
 * silent upgrades). Pure over the immutable raw payload, so a historical
 * row with no stored `served_model` resolves to exactly what a fresh
 * capture would have recorded.
 *
 * Shapes: OpenAI Responses/Chat, Anthropic Messages and Perplexity carry a
 * top-level `model`; Gemini carries `modelVersion`. Anything else → null
 * (unknown, never guessed).
 */
export function extractServedModel(provider: string, payload: unknown): string | null {
  if (payload === null || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const candidate = provider === "google" ? record.modelVersion ?? record.model : record.model;
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate.trim() : null;
}

/** Search mode is part of the requested model id (`+search`) by registry
 * convention (lib/ai/openai.ts, lib/ai/google.ts). */
export function searchModeOf(model: string): "web_search" | "none" {
  return model.endsWith("+search") ? "web_search" : "none";
}

/** No measured provider is sent a location; geography lives in prompt text. */
export const LOCATION_CONTEXT_PROMPT_ONLY = "prompt_text_only";

/**
 * The comparable-instrument key. Two answers are the same instrument only
 * when provider, requested model id (which pins snapshot and search mode),
 * location context and sampling agree. Sampling is provider-default for
 * every adapter today (lib/ai/types.ts) and is recorded in request_params;
 * it is part of the key so a future explicit temperature cannot blend in.
 */
export function instrumentKey(input: {
  provider: string;
  model: string;
  locationContext?: string;
  sampling?: string;
}): string {
  return [
    input.provider,
    input.model,
    input.locationContext ?? LOCATION_CONTEXT_PROMPT_ONLY,
    input.sampling ?? "provider_default",
  ].join("|");
}

/** Read `sampling` from stored request params (provider default when absent). */
export function samplingOf(requestParams: unknown): string {
  if (requestParams && typeof requestParams === "object") {
    const s = (requestParams as Record<string, unknown>).sampling;
    if (typeof s === "string") return s;
    if (s && typeof s === "object") return JSON.stringify(s);
  }
  return "provider_default";
}
