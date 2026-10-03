/**
 * Spec 146A latency diagnostic for `detect_contradictions` v2 on a local model.
 * Tooling only: it grades nothing and decides nothing.
 *
 *   INTERNAL_EVAL_MODEL=qwen3:30b DIAG_FIXTURES=s3_same_period_count,a5_buried \
 *     npx tsx scripts/diagnose-detect-contradictions-latency.ts
 *
 * Each call goes through the production Ollama caller with the production
 * system prompt, user message and response schema, so it sends exactly what
 * `runAgent` would send on attempt 1. It prints the backend's own timing
 * breakdown per call (load, prompt eval, generation, hidden-reasoning size).
 *
 *   DIAG_THINK=true|false  reasoning configuration (unset = model default)
 *   DIAG_REPS              calls per fixture (default 2)
 *   DIAG_COLD_START=1      unload the model first and time the first call
 */
import { responseSchemaFor } from "@/lib/ai/agent";
import { ollamaBaseUrl, ollamaCaller } from "@/lib/ai/internal/ollama";
import { withGuardrails } from "@/lib/automation/prompts";
import { agentUserMessage } from "@/lib/automation/nodes/agent";
import {
  DETECT_CONTRADICTIONS_V2_PREAMBLE,
  DETECT_CONTRADICTIONS_V2_SYSTEM,
  contradictionDetectionV2Schema,
} from "@/lib/automation/contradictions/contract";
import { DETECT_CONTRADICTIONS_GOLD } from "@/tests/fixtures/detect-contradictions-gold";
import type { GoldFixture } from "@/lib/automation/contradictions/contract";

const MODEL = process.env.INTERNAL_EVAL_MODEL ?? "qwen3:30b";
const REPS = Number(process.env.DIAG_REPS ?? "2");
const wanted = (process.env.DIAG_FIXTURES ?? "").split(",").filter(Boolean);
const THINK = process.env.DIAG_THINK === undefined ? undefined : process.env.DIAG_THINK === "true";
const COLD_START = process.env.DIAG_COLD_START === "1";

const SYSTEM = withGuardrails(DETECT_CONTRADICTIONS_V2_SYSTEM);
const RESPONSE_SCHEMA = responseSchemaFor(contradictionDetectionV2Schema);

/**
 * Evict the model from memory so the next call measures a cold load. Model
 * residency has no provider-neutral equivalent, so this is the script's only
 * direct Ollama request (spec 146A §4).
 */
async function unloadModel(): Promise<void> {
  await fetch(`${ollamaBaseUrl()}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, keep_alive: 0 }),
  });
}

async function measure(fixture: GoldFixture, label: string): Promise<void> {
  const started = Date.now();
  const result = await ollamaCaller({
    system: SYSTEM,
    user: agentUserMessage(DETECT_CONTRADICTIONS_V2_PREAMBLE, fixture.context, {}),
    model: MODEL,
    responseSchema: RESPONSE_SCHEMA,
    ...(THINK === undefined ? {} : { think: THINK }),
  });
  const wall = Date.now() - started;
  const t = result.timings ?? {};
  const genMs = t.generationMs ?? 0;
  console.log(
    [
      fixture.id,
      label,
      wall,
      result.durationMs ?? "",
      t.loadMs ?? "",
      result.tokensIn,
      t.promptEvalMs ?? "",
      result.tokensOut,
      genMs,
      genMs > 0 ? (result.tokensOut / (genMs / 1000)).toFixed(1) : "",
      t.reasoningChars ?? "",
      result.text.length,
    ].join(",")
  );
}

async function main(): Promise<void> {
  const fixtures = DETECT_CONTRADICTIONS_GOLD.filter(
    (f) => f.split === "holdout" && (wanted.length === 0 || wanted.includes(f.id))
  );
  if (fixtures.length === 0) throw new Error("no holdout fixtures match DIAG_FIXTURES");
  console.log(`# model=${MODEL} think=${THINK === undefined ? "default" : String(THINK)} reps=${REPS}`);
  console.log(
    "fixture,rep,wall_ms,total_ms,load_ms,prompt_tokens,prompt_ms,output_tokens,gen_ms,tok_per_s,reasoning_chars,content_chars"
  );
  if (COLD_START) {
    await unloadModel();
    await measure(fixtures[0]!, "cold");
  }
  for (const fixture of fixtures) {
    for (let rep = 1; rep <= REPS; rep += 1) {
      await measure(fixture, String(rep));
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
