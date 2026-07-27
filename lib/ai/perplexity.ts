/**
 * Perplexity adapter — OpenAI-compatible chat completions at
 * api.perplexity.ai (no extra SDK dependency). Sonar models return search
 * citations; they ride along in raw_payload and, where the answer text
 * carries URLs, the parser attributes them to companies by domain.
 */
import OpenAI from "openai";
import type { AIProvider, PromptRequest, ProviderResult } from "@/lib/ai/types";

let client: OpenAI | undefined;

function getClient(): OpenAI {
  if (!client) {
    if (!process.env.PERPLEXITY_API_KEY) {
      throw Object.assign(new Error("PERPLEXITY_API_KEY is not configured"), {
        status: 401,
      });
    }
    client = new OpenAI({
      apiKey: process.env.PERPLEXITY_API_KEY,
      baseURL: "https://api.perplexity.ai",
      maxRetries: 0,
    });
  }
  return client;
}

export const perplexityProvider: AIProvider = {
  id: "perplexity",
  // Model ids pinned 2026-07-27 — UNVERIFIED; confirm before the first real run
  models: [
    { id: "sonar", label: "Perplexity Sonar", provider: "perplexity" },
    { id: "sonar-pro", label: "Perplexity Sonar Pro", provider: "perplexity" },
  ],

  async runPrompt(req: PromptRequest): Promise<ProviderResult> {
    const response = await getClient().chat.completions.create({
      model: req.model,
      messages: [{ role: "user", content: req.promptText }],
    });

    const choice = response.choices[0];
    return {
      rawPayload: response,
      responseText: choice?.message?.content ?? "",
      refusal: choice?.finish_reason === "content_filter",
      tokensIn: response.usage?.prompt_tokens ?? 0,
      tokensOut: response.usage?.completion_tokens ?? 0,
    };
  },
};
