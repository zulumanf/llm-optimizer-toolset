/**
 * Spec 146 promotion eval for `detect_contradictions` v2 on a local model.
 *
 *   INTERNAL_EVAL_MODEL=qwen3:30b npx tsx scripts/eval-detect-contradictions-internal.ts
 *
 * Runs every fixture of the chosen split (default: holdout) REPS times through
 * the production `runAgent` path (Ollama backend, one schema retry), with the
 * exact system prompt (v2 + shared guardrails) and user message the `compare`
 * node would send. Answers are validated deterministically, then graded in
 * code against the frozen gold labels. No LLM judges anything.
 *
 * Promotes nothing. It prints the numbers and PASS/FAIL against the fixed
 * spec 146 §8 gates, and exits non-zero on FAIL.
 *
 *   EVAL_SPLIT=dev|holdout   default holdout (the promotion split)
 *   EVAL_THINK=true|false    reasoning configuration under test (spec 146A)
 *   EVAL_OUT=<path>          also write the full runs as JSON
 */
import { writeFileSync } from "node:fs";
import { runAgent } from "@/lib/ai/agent";
import { withGuardrails } from "@/lib/automation/prompts";
import { agentUserMessage } from "@/lib/automation/nodes/agent";
import {
  DETECT_CONTRADICTIONS_V2_PREAMBLE,
  DETECT_CONTRADICTIONS_V2_SYSTEM,
  DETECT_CONTRADICTIONS_V2_VERSION,
  PROMOTION_GATES,
  contradictionDetectionV2Schema,
  gradeContradictionOutput,
  isCriticalFixture,
  summarizeEval,
  validateContradictionOutput,
  type EvalRun,
  type GoldFixture,
  type RunFailure,
} from "@/lib/automation/contradictions/contract";
import {
  DETECT_CONTRADICTIONS_GOLD,
  GOLD_DATASET_SHA256,
  goldDatasetHash,
} from "@/tests/fixtures/detect-contradictions-gold";

const CANDIDATES = ["qwen3:30b", "gpt-oss:20b", "qwen3:8b"] as const;
const REPS = 3;
/** The `compare` node's timeout (verify() default). */
const CALL_TIMEOUT_MS = 300_000;

if (process.env.OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY must be unset for this local-model promotion eval");
}

const MODEL = process.env.INTERNAL_EVAL_MODEL ?? "";
if (!(CANDIDATES as readonly string[]).includes(MODEL)) {
  throw new Error(`INTERNAL_EVAL_MODEL must be one of ${CANDIDATES.join(", ")}`);
}
const SPLIT = process.env.EVAL_SPLIT === "dev" ? "dev" : "holdout";
/**
 * The reasoning configuration under test (spec 146A §3A), sent through the
 * provider-neutral `think` request field. Unset = the model's default. It
 * changes decoding, so each value is a separate candidate configuration and is
 * printed with every result.
 */
const THINK =
  process.env.EVAL_THINK === undefined ? undefined : process.env.EVAL_THINK === "true";

if (goldDatasetHash() !== GOLD_DATASET_SHA256) {
  throw new Error("Gold dataset hash mismatch — the labels changed after freezing (spec 146 §6).");
}

const SYSTEM = withGuardrails(DETECT_CONTRADICTIONS_V2_SYSTEM);

class CallTimeout extends Error {}

async function call(fixture: GoldFixture): Promise<unknown> {
  const user = agentUserMessage(DETECT_CONTRADICTIONS_V2_PREAMBLE, fixture.context, {});
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CallTimeout(`timed out after ${CALL_TIMEOUT_MS} ms`)), CALL_TIMEOUT_MS);
  });
  try {
    const run = await Promise.race([
      runAgent({
        agentVersion: DETECT_CONTRADICTIONS_V2_VERSION,
        system: SYSTEM,
        user,
        schema: contradictionDetectionV2Schema,
        model: MODEL,
        backend: "ollama",
        purpose: "eval:detect_contradictions_v2",
        ...(THINK === undefined ? {} : { think: THINK }),
      }),
      timeout,
    ]);
    return run.output;
  } finally {
    clearTimeout(timer);
  }
}

function classify(error: unknown): RunFailure {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("produced invalid output twice") ? "schema" : "runtime";
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

async function main(): Promise<void> {
  const fixtures = DETECT_CONTRADICTIONS_GOLD.filter((f) => f.split === SPLIT);
  console.log(
    `MODEL=${MODEL} think=${THINK === undefined ? "default" : String(THINK)} split=${SPLIT} fixtures=${fixtures.length} reps=${REPS} dataset=${GOLD_DATASET_SHA256.slice(0, 12)}`
  );

  // One ungraded warm-up call, so model load time is not counted as one graded
  // call's inference time (spec 146A §4). Cold start is measured by
  // scripts/diagnose-detect-contradictions-latency.ts, not here.
  const warmStarted = Date.now();
  let warmUpMs: number | null = null;
  try {
    await call(fixtures[0]!);
    warmUpMs = Date.now() - warmStarted;
  } catch {
    // A warm-up failure is not graded; a real outage fails every graded run.
  }
  console.log(`warm-up (ungraded): ${warmUpMs ?? "failed"} ms`);

  const runs: EvalRun[] = [];
  for (const fixture of fixtures) {
    for (let rep = 1; rep <= REPS; rep += 1) {
      const started = Date.now();
      let run: EvalRun;
      try {
        const output = await call(fixture);
        const durationMs = Date.now() - started;
        const validation = validateContradictionOutput(output, fixture.context);
        if (!validation.ok) {
          run = { fixtureId: fixture.id, rep, failure: validation.kind, grade: null, durationMs };
          console.log(`[${fixture.id} #${rep}] ${validation.kind.toUpperCase()} FAILURE ${durationMs}ms: ${validation.errors.join("; ")}`);
          console.log(`  output: ${JSON.stringify(output)}`);
        } else {
          const grade = gradeContradictionOutput(fixture, validation.output);
          run = { fixtureId: fixture.id, rep, failure: null, grade, durationMs };
          const failed = grade.checks.filter((c) => !c.passed);
          console.log(
            `[${fixture.id} #${rep}]${isCriticalFixture(fixture) ? " [critical]" : ""} ${failed.length === 0 ? "PASS" : "FAIL"} ${durationMs}ms pairs=${grade.signature || "(none)"}`
          );
          for (const check of failed) {
            console.log(`  FAIL ${check.critical ? "[CRITICAL] " : ""}${check.name}`);
          }
          if (failed.length > 0) {
            console.log(`  output: ${JSON.stringify(validation.output)}`);
          }
        }
      } catch (error) {
        const failure = error instanceof CallTimeout ? "runtime" : classify(error);
        run = { fixtureId: fixture.id, rep, failure, grade: null, durationMs: Date.now() - started };
        console.log(`[${fixture.id} #${rep}] ${failure.toUpperCase()} FAILURE: ${error instanceof Error ? error.message : String(error)}`);
      }
      runs.push(run);
    }
  }

  const summary = summarizeEval(fixtures, runs);
  const failures = summary.failures.runtime + summary.failures.schema + summary.failures.validation;

  console.log("\n================================");
  console.log(`DETECT CONTRADICTIONS v2 EVAL — ${MODEL} (${SPLIT})`);
  console.log("================================");
  console.log(`runs: ${summary.runs}`);
  console.log(`critical runs: ${summary.criticalRunsPassed}/${summary.criticalRuns}`);
  console.log(`critical checks: ${summary.criticalChecksPassed}/${summary.criticalChecks}`);
  console.log(`overall: ${summary.checksPassed}/${summary.checks} = ${pct(summary.overallPassRate)}`);
  console.log(`recall: ${pct(summary.recall)}`);
  console.log(`false-positive rate: ${pct(summary.falsePositiveRate)}`);
  console.log(`severity accuracy: ${pct(summary.severityAccuracy)}`);
  console.log(`consistency: ${pct(summary.consistency)} (critical ${pct(summary.criticalConsistency)})`);
  console.log(
    `failures: runtime ${summary.failures.runtime}, schema ${summary.failures.schema}, validation ${summary.failures.validation} (total ${failures})`
  );
  console.log(`latency p50: ${summary.p50LatencyMs ?? "n/a"} ms, p95: ${summary.p95LatencyMs ?? "n/a"} ms`);
  console.log("external API cost: $0 (backend ollama, OPENAI_API_KEY unset)");
  for (const [gate, ok] of Object.entries(summary.gates)) {
    console.log(`gate ${gate} (${PROMOTION_GATES[gate as keyof typeof PROMOTION_GATES]}): ${ok ? "PASS" : "FAIL"}`);
  }
  console.log(`RESULT: ${summary.passed ? "PASS" : "FAIL"}`);
  const think = THINK === undefined ? "default" : THINK;
  console.log(`EVAL_SUMMARY ${JSON.stringify({ model: MODEL, think, split: SPLIT, warmUpMs, ...summary })}`);

  if (process.env.EVAL_OUT) {
    writeFileSync(
      process.env.EVAL_OUT,
      JSON.stringify({ model: MODEL, think, split: SPLIT, warmUpMs, summary, runs }, null, 2)
    );
  }
  if (!summary.passed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
