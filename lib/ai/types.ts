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

/** Full capture of one provider call. rawPayload is stored verbatim (docs/07 step 4). */
export interface ProviderResult {
  rawPayload: unknown;
  responseText: string;
  /** Provider declined to answer — a valid measurement, never retried (docs/12). */
  refusal: boolean;
  tokensIn: number;
  tokensOut: number;
}

export interface AIProvider {
  id: ProviderId;
  models: ModelInfo[];
  runPrompt(req: PromptRequest): Promise<ProviderResult>;
}
