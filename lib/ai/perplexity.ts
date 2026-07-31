/**
 * Perplexity adapter — OpenAI-compatible chat completions at
 * api.perplexity.ai (no extra SDK dependency). Sonar models return search
 * citations; they ride along in raw_payload and, where the answer text
 * carries URLs, the parser attributes them to companies by domain.
 */
import OpenAI from "openai";
import type { AIProvider, PromptRequest, ProviderResult } from "@/lib/ai/types";
import { parseChatCompletion } from "@/lib/ai/payloads";

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

    // Perplexity serves the OpenAI chat-completions contract, so it shares
    // that parser rather than keeping a second copy of the same logic that
    // could drift. An unrecognised shape is flagged, not read as an empty
    // answer (docs/09).
    return { rawPayload: response, ...parseChatCompletion(response) };
  },
};
