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
  // Model ids pinned 2026-07-27 — verify against the OpenAI models list
  // before the first real run (docs/12: exact pinned ids)
  models: [
    { id: "gpt-5.1", label: "GPT-5.1", provider: "openai" },
    { id: "gpt-5", label: "GPT-5", provider: "openai" },
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
