/**
 * LLM agent runner (docs/15 agent contract, first used by spec 010).
 * One entry point for structured agent calls: pinned model, JSON output,
 * Zod validation with a single retry, cost accounting, and an injectable
 * caller so tests never touch the network. OpenAI-backed (the operator's
 * only provider); the vendor SDK stays inside lib/ai (docs/02).
 */
import OpenAI from "openai";
import type { z } from "zod";
import { ClassifiedError } from "@/lib/errors";
import { costMicroUsd } from "@/lib/ai/pricing";
import { log } from "@/lib/logger";

/** Pinned agent model — flagship for reasoning-quality agent work; recorded
 * in every agent output's version string. */
export const AGENT_MODEL = "gpt-5.4-2026-03-05";

export interface AgentCallResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
}

export type AgentCaller = (args: {
  system: string;
  user: string;
  /** Model override; defaults to AGENT_MODEL when omitted. */
  model?: string;
}) => Promise<AgentCallResult>;

let client: OpenAI | undefined;

const openaiCaller: AgentCaller = async ({ system, user, model }) => {
  if (!process.env.OPENAI_API_KEY) {
    throw new ClassifiedError(
      "provider_auth",
      "OPENAI_API_KEY is not configured — LLM agents need it."
    );
  }
  if (!client) client = new OpenAI({ maxRetries: 1 });
  const response = await client.chat.completions.create({
    model: model ?? AGENT_MODEL,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  return {
    text: response.choices[0]?.message?.content ?? "",
    tokensIn: response.usage?.prompt_tokens ?? 0,
    tokensOut: response.usage?.completion_tokens ?? 0,
  };
};

export interface AgentRun<T> {
  output: T;
  costMicroUsd: number;
  attempts: number;
}

/**
 * Run an agent prompt and validate its JSON against `schema`. One retry on
 * invalid JSON/schema (docs/13 rule), then a classified failure — agents
 * never "kind of" succeed.
 */
export async function runAgent<T>(args: {
  agentVersion: string;
  system: string;
  user: string;
  /** Input side is `unknown` on purpose: the value parsed comes from
   * JSON.parse, and schemas that apply `.default()` have an input type that
   * differs from their output type (spec 018 agent schemas). */
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  /** Model override — cheap snapshots for narrow, high-volume judgments. */
  model?: string;
  caller?: AgentCaller;
}): Promise<AgentRun<T>> {
  const caller = args.caller ?? openaiCaller;
  const model = args.model ?? AGENT_MODEL;
  let cost = 0;
  let lastError = "";

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const prompt =
      attempt === 1
        ? args.user
        : `${args.user}\n\nYour previous output was invalid (${lastError.slice(0, 300)}). Return ONLY valid JSON matching the required shape.`;
    const result = await caller({ system: args.system, user: prompt, model });
    cost += costMicroUsd(model, result.tokensIn, result.tokensOut);
    try {
      const parsed = args.schema.safeParse(JSON.parse(result.text));
      if (parsed.success) {
        log("info", "agent.run", {
          agent: args.agentVersion,
          attempts: attempt,
          costMicroUsd: cost,
        });
        return { output: parsed.data, costMicroUsd: cost, attempts: attempt };
      }
      lastError = parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
    } catch (err) {
      lastError = err instanceof Error ? err.message : "invalid JSON";
    }
  }
  throw new ClassifiedError(
    "validation",
    `Agent ${args.agentVersion} produced invalid output twice: ${lastError.slice(0, 300)}`
  );
}
