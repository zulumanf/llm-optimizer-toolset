/**
 * Perplexity adapter — OpenAI-compatible chat completions at
 * api.perplexity.ai (no extra SDK dependency). Sonar models return search
 * citations; they ride along in raw_payload and, where the answer text
 * carries URLs, the parser attributes them to companies by domain.
 */
import OpenAI from "openai";
import type { AIProvider, PromptRequest, ProviderResult } from "@/lib/ai/types";
import { parseChatCompletion } from "@/lib/ai/payloads";
import { PROVIDER_TIMEOUT_MS } from "@/lib/ai/limits";

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
      timeout: PROVIDER_TIMEOUT_MS,
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
    return {
      rawPayload: response,
      ...parseChatCompletion(response),
      requestParams: { sampling: "provider_default" },
    };
  },
};

// ------------------------------------------------ research (spec 079)

/** Injectable transport so tests never touch the network (docs/09). */
export type PerplexityResearchCaller = (args: {
  model: string;
  system: string;
  user: string;
  maxTokens: number;
}) => Promise<{ text: string; citations: string[]; tokensIn: number; tokensOut: number }>;

const liveResearchCaller: PerplexityResearchCaller = async (args) => {
  const response = await getClient().chat.completions.create({
    model: args.model,
    max_tokens: args.maxTokens,
    messages: [
      { role: "system", content: args.system },
      { role: "user", content: args.user },
    ],
  });
  const raw = response as unknown as { citations?: unknown; search_results?: Array<{ url?: string }> };
  const citations = Array.isArray(raw.citations)
    ? raw.citations.filter((c): c is string => typeof c === "string")
    : (raw.search_results ?? [])
        .map((r) => r?.url)
        .filter((u): u is string => typeof u === "string");
  return {
    text: response.choices[0]?.message?.content ?? "",
    citations,
    tokensIn: response.usage?.prompt_tokens ?? 0,
    tokensOut: response.usage?.completion_tokens ?? 0,
  };
};

export interface PerplexityResearchResult<T> {
  output: T;
  citations: string[];
  costMicroUsd: number;
}

/**
 * One search-grounded question, strict JSON out, one retry on a schema
 * miss (the runAgent contract), every attempt ledgered under
 * `agentVersion` (spec 050). Cheapest capable model by default — the
 * operator's efficiency requirement is structural, not aspirational.
 */
export async function perplexityResearch<T>(args: {
  agentVersion: string;
  system: string;
  user: string;
  schema: import("zod").ZodType<T, import("zod").ZodTypeDef, unknown>;
  model?: string;
  maxTokens?: number;
  purpose?: string | null;
  caller?: PerplexityResearchCaller;
}): Promise<PerplexityResearchResult<T>> {
  const { costMicroUsd } = await import("@/lib/ai/pricing");
  const { recordLlmCall } = await import("@/lib/ai/ledger");
  const { ClassifiedError } = await import("@/lib/errors");
  const caller = args.caller ?? liveResearchCaller;
  const model = args.model ?? "sonar";
  const maxTokens = args.maxTokens ?? 700;

  let cost = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let lastError = "";

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const user =
      attempt === 1
        ? args.user
        : `${args.user}\n\nYour previous reply was not valid JSON for the required shape (${lastError}). Reply with ONLY the JSON object.`;
    const result = await caller({ model, system: args.system, user, maxTokens });
    tokensIn += result.tokensIn;
    tokensOut += result.tokensOut;
    cost += costMicroUsd(model, result.tokensIn, result.tokensOut);

    try {
      const cleaned = result.text.trim().replace(/^```(?:json)?\n?|\n?```$/g, "");
      const parsed = args.schema.safeParse(JSON.parse(cleaned));
      if (parsed.success) {
        await recordLlmCall({
          agentVersion: args.agentVersion,
          model,
          purpose: args.purpose ?? null,
          tokensIn,
          tokensOut,
          costMicroUsd: cost,
          attempts: attempt,
          success: true,
        });
        return { output: parsed.data, citations: result.citations, costMicroUsd: cost };
      }
      lastError = parsed.error.issues[0]?.message ?? "schema mismatch";
    } catch (err) {
      lastError = err instanceof Error ? err.message : "invalid JSON";
    }
  }

  await recordLlmCall({
    agentVersion: args.agentVersion,
    model,
    purpose: args.purpose ?? null,
    tokensIn,
    tokensOut,
    costMicroUsd: cost,
    attempts: 2,
    success: false,
  });
  throw new ClassifiedError(
    "validation",
    `Perplexity research did not return valid JSON after a retry (${lastError}).`
  );
}
