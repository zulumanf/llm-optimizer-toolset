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

export const openaiProvider: AIProvider = {
  id: "openai",
  // Dated snapshots pinned 2026-07-27, VERIFIED against the account's live
  // /v1/models list (docs/12: exact ids, never floating aliases — the
  // -chat-latest aliases change underneath and would break comparability)
  models: [
    { id: "gpt-5.4-2026-03-05", label: "GPT-5.4", provider: "openai" },
    { id: "gpt-5.4-mini-2026-03-17", label: "GPT-5.4 Mini", provider: "openai" },
  ],

  async runPrompt(req: PromptRequest): Promise<ProviderResult> {
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
