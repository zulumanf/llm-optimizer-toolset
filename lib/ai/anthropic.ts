import Anthropic from "@anthropic-ai/sdk";
import type { AIProvider, PromptRequest, ProviderResult } from "@/lib/ai/types";
import { parseAnthropicMessage } from "@/lib/ai/payloads";
import { PROVIDER_TIMEOUT_MS } from "@/lib/ai/limits";

/**
 * Search-enabled variants use the server-side `web_search` tool, matching the
 * convention the OpenAI and Google adapters follow: a grounded run is a
 * different instrument, so it gets a distinct model id rather than a flag
 * (docs/07). `lib/ai/citations.ts` already reads the resulting
 * `content[].citations[]`.
 */
const SEARCH_SUFFIX = "+search";
/** Pinned tool version — an undated tool id would drift like a model alias. */
const WEB_SEARCH_TOOL = "web_search_20250305";
const MAX_SEARCHES_PER_ANSWER = 5;

function isSearchModel(modelId: string): boolean {
  return modelId.endsWith(SEARCH_SUFFIX);
}

export function baseModelId(modelId: string): string {
  return isSearchModel(modelId) ? modelId.slice(0, -SEARCH_SUFFIX.length) : modelId;
}

// Cap on thinking + response tokens per answer; billing follows actual usage.
const MAX_TOKENS = 8192;

let client: Anthropic | undefined;

function getClient(): Anthropic {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw Object.assign(new Error("ANTHROPIC_API_KEY is not configured"), {
        status: 401,
      });
    }
    // maxRetries: 0 — retries are owned by lib/ai/retry.ts so all providers
    // share one policy and budget checks run between attempts (docs/12)
    client = new Anthropic({ maxRetries: 0, timeout: PROVIDER_TIMEOUT_MS });
  }
  return client;
}

export const anthropicProvider: AIProvider = {
  id: "anthropic",
  // UNVERIFIED: no Anthropic key has ever been configured, so neither these
  // ids nor the search tool have been executed once. Gemini taught the lesson
  // — `gemini-2.5-flash` listed fine and returned 404 on every call — so treat
  // these as declared, not confirmed, until a real call succeeds.
  models: [
    { id: "claude-opus-5", label: "Claude Opus 5", provider: "anthropic" },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5", provider: "anthropic" },
    { id: `claude-opus-5${SEARCH_SUFFIX}`, label: "Claude Opus 5 + web search", provider: "anthropic" },
    { id: `claude-sonnet-5${SEARCH_SUFFIX}`, label: "Claude Sonnet 5 + web search", provider: "anthropic" },
  ],

  async runPrompt(req: PromptRequest): Promise<ProviderResult> {
    const response = await getClient().messages.create({
      model: baseModelId(req.model),
      max_tokens: MAX_TOKENS,
      messages: [{ role: "user", content: req.promptText }],
      ...(isSearchModel(req.model)
        ? {
            tools: [
              {
                type: WEB_SEARCH_TOOL,
                name: "web_search",
                max_uses: MAX_SEARCHES_PER_ANSWER,
              },
            ],
          }
        : {}),
    } as Parameters<ReturnType<typeof getClient>["messages"]["create"]>[0]);

    // Parsing lives in lib/ai/payloads.ts: testable without a network call,
    // and an unrecognised shape is flagged rather than read as an empty
    // answer. A refusal (stop_reason) stays a valid measurement (docs/12).
    return { rawPayload: response, ...parseAnthropicMessage(response) };
  },
};
