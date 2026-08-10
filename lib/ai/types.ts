/** Provider abstraction contract (docs/02, docs/12). Vendor SDKs are imported
 * only inside lib/ai/ adapters — never in feature code. */

export const PROVIDER_IDS = [
  "anthropic",
  "openai",
  "google",
  "perplexity",
  "mock",
] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface ModelInfo {
  id: string;
  label: string;
  provider: ProviderId;
}

export interface PromptRequest {
  model: string;
  promptText: string;
}

/**
 * The sampling configuration the adapter ACTUALLY sent (spec 050). Recorded
 * on every response so a measurement can be replayed to the same
 * configuration — docs/07 promised this and nothing implemented it. Fields
 * left at provider defaults are recorded as the string "provider_default"
 * (a truthful statement, unlike omitting them); explicitly-set values are
 * recorded as values. Required, so an adapter cannot forget to declare.
 */
export interface RequestParams {
  sampling: "provider_default" | Record<string, number>;
  maxTokens?: number;
  tools?: string[];
  [key: string]: unknown;
}

/** Full capture of one provider call. rawPayload is stored verbatim (docs/07 step 4). */
export interface ProviderResult {
  rawPayload: unknown;
  responseText: string;
  /** Provider declined to answer — a valid measurement, never retried (docs/12). */
  refusal: boolean;
  tokensIn: number;
  tokensOut: number;
  /**
   * False when the payload did not match a shape the adapter knows (docs/09:
   * "unknown shape → captured raw + flagged, never silently dropped").
   *
   * An empty `responseText` means two very different things — the model
   * answered with nothing, or our parser broke because the provider changed
   * its format. Without this flag they are indistinguishable, and a format
   * change shows up as a run of silently empty answers. Absent means
   * recognised, so existing adapters and the mock provider need no change.
   */
  shapeRecognized?: boolean;
  /** Why the shape was not recognised. Set only when shapeRecognized is false. */
  shapeNote?: string;
  /** What the adapter sent — stored on the response row (spec 050). */
  requestParams: RequestParams;
}

export interface AIProvider {
  id: ProviderId;
  models: ModelInfo[];
  runPrompt(req: PromptRequest): Promise<ProviderResult>;
}
