import Anthropic from "@anthropic-ai/sdk";
import type { AIProvider, PromptRequest, ProviderResult } from "@/lib/ai/types";

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
    client = new Anthropic({ maxRetries: 0 });
  }
  return client;
}

export const anthropicProvider: AIProvider = {
  id: "anthropic",
  models: [
    { id: "claude-opus-5", label: "Claude Opus 5", provider: "anthropic" },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5", provider: "anthropic" },
  ],

  async runPrompt(req: PromptRequest): Promise<ProviderResult> {
    const response = await getClient().messages.create({
      model: req.model,
      max_tokens: MAX_TOKENS,
      messages: [{ role: "user", content: req.promptText }],
    });

    // A refusal (stop_reason) is a valid measurement, not an error (docs/12)
    const refusal = response.stop_reason === "refusal";
    const responseText = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    return {
      rawPayload: response,
      responseText,
      refusal,
      tokensIn: response.usage.input_tokens,
      tokensOut: response.usage.output_tokens,
    };
  },
};
