/**
 * LLM agent runner (docs/15 agent contract, first used by spec 010).
 * One entry point for structured internal-agent calls: pinned model, JSON
 * output, Zod validation with a single retry, cost accounting, and an
 * injectable provider-neutral inference caller.
 *
 * OpenAI remains the default backend for now. Other internal inference
 * backends (such as Ollama) plug into the same contract.
 */
import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type {
  InternalInferenceBackend,
  InternalInferenceCaller,
  InternalInferenceResult,
} from "@/lib/ai/internal-inference";
import { callerForInternalBackend } from "@/lib/ai/internal/registry";
import { ClassifiedError } from "@/lib/errors";
import { costMicroUsd } from "@/lib/ai/pricing";
import { log } from "@/lib/logger";

/** Pinned agent model — flagship for reasoning-quality agent work; recorded
 * in every agent output's version string. */
export const AGENT_MODEL = "gpt-5.4-2026-03-05";

/**
 * Backwards-compatible names used by existing feature code.
 * The canonical contract now lives in internal-inference.ts.
 */
export type AgentCallResult = InternalInferenceResult;
export type AgentCaller = InternalInferenceCaller;

export interface AgentRun<T> {
  output: T;
  costMicroUsd: number;
  attempts: number;
  backend: InternalInferenceBackend;
  model: string;
  durationMs: number;
}

/**
 * The JSON Schema `runAgent` sends for constrained generation. Exported so
 * tooling sends exactly what production would (spec 146A).
 */
export function responseSchemaFor(schema: z.ZodTypeAny): Record<string, unknown> {
  return zodToJsonSchema(schema, { $refStrategy: "none" }) as Record<string, unknown>;
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
  /** The routed model (spec 055): every caller resolves via
   * lib/ai/routing.modelForTask — no frontier default to land on. */
  model: string;
  /**
   * Internal inference backend. Existing behavior remains OpenAI unless
   * explicitly changed by a reviewed route.
   */
  backend?: InternalInferenceBackend;
  /** Ledger attribution (spec 050): which project this spend serves, and a
   * short label for the calling pipeline. Optional — unattributed calls
   * still count in the global ceiling. */
  projectId?: string | null;
  purpose?: string | null;
  caller?: AgentCaller;
  /** Backend reasoning-mode switch; omitted = model default (spec 146A). */
  think?: boolean;
}): Promise<AgentRun<T>> {
  const backend = args.backend ?? "openai";
  const caller = args.caller ?? callerForInternalBackend(backend);
  const model = args.model;

  const responseSchema = responseSchemaFor(args.schema as z.ZodTypeAny);

  let cost = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let durationMs = 0;
  let lastError = "";

  const record = async (attempts: number, success: boolean) => {
    // Lazy import keeps lib/ai/agent importable without a DB (pure callers).
    const { recordLlmCall } = await import("@/lib/ai/ledger");
    await recordLlmCall({
      agentVersion: args.agentVersion,
      model,
      backend,
      durationMs,
      purpose: args.purpose ?? null,
      projectId: args.projectId ?? null,
      tokensIn,
      tokensOut,
      costMicroUsd: cost,
      attempts,
      success,
    });
  };

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const prompt =
      attempt === 1
        ? args.user
        : `${args.user}\n\nYour previous output was invalid (${lastError.slice(0, 300)}). Return ONLY valid JSON matching the required shape.`;
    const result = await caller({
      system: args.system,
      user: prompt,
      model,
      responseSchema,
      ...(args.think === undefined ? {} : { think: args.think }),
    });
    // Local inference has no per-call provider invoice. Do not invent one.
    // Resource usage remains visible through backend/model/tokens/duration.
    if (backend !== "ollama") {
      cost += costMicroUsd(model, result.tokensIn, result.tokensOut);
    }
    tokensIn += result.tokensIn;
    tokensOut += result.tokensOut;
    durationMs += result.durationMs ?? 0;
    try {
      const parsed = args.schema.safeParse(JSON.parse(result.text));
      if (parsed.success) {
        log("info", "agent.run", {
          agent: args.agentVersion,
          backend,
          model,
          attempts: attempt,
          costMicroUsd: cost,
          durationMs,
        });
        await record(attempt, true);
        return {
          output: parsed.data,
          costMicroUsd: cost,
          attempts: attempt,
          backend,
          model,
          durationMs,
        };
      }
      lastError = parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
    } catch (err) {
      lastError = err instanceof Error ? err.message : "invalid JSON";
    }
  }
  // The spend happened even though the agent failed — the ledger records it.
  await record(2, false);
  throw new ClassifiedError(
    "validation",
    `Agent ${args.agentVersion} produced invalid output twice: ${lastError.slice(0, 300)}`
  );
}
