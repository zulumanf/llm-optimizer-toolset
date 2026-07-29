import OpenAI from "openai";
import type { AIProvider, PromptRequest, ProviderResult } from "@/lib/ai/types";

let client: OpenAI | undefined;

function getClient(): OpenAI {
  if (!client) {
    if (!process.env.OPENAI_API_KEY) {
      throw Object.assign(new Error("OPENAI_API_KEY is not configured"), {
        status: 401,
      });
    }
    // maxRetries: 0 — retries are owned by lib/ai/retry.ts (see anthropic.ts)
    client = new OpenAI({ maxRetries: 0 });
  }
  return client;
}

/**
 * Search-enabled variants run through the Responses API with the web_search
 * tool — closer to consumer ChatGPT (which searches by default) and the
 * response carries url_citation annotations: the actual retrieval sources.
 * Shape verified live 2026-07-28 against this account. A search-enabled run
 * is a DIFFERENT instrument than a no-search run (docs/07): distinct model
 * ids so runs pin the mode explicitly.
 */
const SEARCH_SUFFIX = "+search";

function isSearchModel(modelId: string): boolean {
  return modelId.endsWith(SEARCH_SUFFIX);
}

/** The underlying dated snapshot for a search-enabled model id. */
export function baseModelId(modelId: string): string {
  return isSearchModel(modelId)
    ? modelId.slice(0, -SEARCH_SUFFIX.length)
    : modelId;
}

interface ResponsesPayload {
  output?: {
    type: string;
    content?: { type: string; text?: string }[];
  }[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

export const openaiProvider: AIProvider = {
  id: "openai",
  // Dated snapshots pinned 2026-07-27, VERIFIED against the account's live
  // /v1/models list (docs/12: exact ids, never floating aliases — the
  // -chat-latest aliases change underneath and would break comparability)
  models: [
    { id: "gpt-5.4-2026-03-05", label: "GPT-5.4", provider: "openai" },
    { id: "gpt-5.4-mini-2026-03-17", label: "GPT-5.4 Mini", provider: "openai" },
    {
      id: `gpt-5.4-2026-03-05${SEARCH_SUFFIX}`,
      label: "GPT-5.4 + web search",
      provider: "openai",
    },
    {
      id: `gpt-5.4-mini-2026-03-17${SEARCH_SUFFIX}`,
      label: "GPT-5.4 Mini + web search",
      provider: "openai",
    },
  ],

  async runPrompt(req: PromptRequest): Promise<ProviderResult> {
    if (isSearchModel(req.model)) {
      const response = (await getClient().responses.create({
        model: baseModelId(req.model),
        tools: [{ type: "web_search" }],
        input: req.promptText,
      })) as unknown as ResponsesPayload;

      const text = (response.output ?? [])
        .filter((item) => item.type === "message")
        .flatMap((item) => item.content ?? [])
        .filter((c) => c.type === "output_text")
        .map((c) => c.text ?? "")
        .join("\n");

      return {
        rawPayload: response,
        responseText: text,
        refusal: false,
        tokensIn: response.usage?.input_tokens ?? 0,
        tokensOut: response.usage?.output_tokens ?? 0,
      };
    }

    const response = await getClient().chat.completions.create({
      model: req.model,
      messages: [{ role: "user", content: req.promptText }],
    });

    const choice = response.choices[0];
    const refusal =
      Boolean(choice?.message?.refusal) || choice?.finish_reason === "content_filter";

    return {
      rawPayload: response,
      responseText: choice?.message?.content ?? "",
      refusal,
      tokensIn: response.usage?.prompt_tokens ?? 0,
      tokensOut: response.usage?.completion_tokens ?? 0,
    };
  },
};
