/**
 * Run executor — the worker's execute_run handler (spec 003, docs/07 steps 3-4).
 * Idempotent and resumable: cells with a successful capture are skipped, so a
 * crashed or retried run continues without duplicating data (the partial
 * unique index is the backstop). Raw payloads are captured before anything
 * else touches them; failed calls are captured with their classified error.
 */
import { sql } from "@/db/client";
import { getRun, successfulCellKeys, runCostMicroUsd } from "@/db/runs";
import type { FrozenPrompt } from "@/lib/prompts/types";
import { getProvider } from "@/lib/ai/registry";
import { withRetry } from "@/lib/ai/retry";
import { costMicroUsd, microToUsd, usdToMicro } from "@/lib/ai/pricing";
import { ClassifiedError } from "@/lib/errors";
import { log } from "@/lib/logger";
import { expandCells, type Cell } from "@/lib/runs/cells";
import { concurrencyFor, createRateGate } from "@/lib/ai/limits";

/** Ceiling. The effective figure is the lowest limit among the run's providers. */
const CONCURRENCY = 4;
const CANCEL_CHECK_EVERY = 5;

interface ExecState {
  cancelled: boolean;
  budgetExhausted: boolean;
  spentMicro: number;
  failed: number;
  launched: number;
}

export async function executeRun(runId: string): Promise<void> {
  const run = await getRun(runId);
  if (!run) throw new ClassifiedError("not_found", `Run ${runId} not found.`);
  if (run.status === "completed") return;
  if (run.status === "partial" && run.statusDetail === "cancelled") {
    // Cancelled while queued — respect the cancel (retry resets to pending)
    return;
  }

  const [version] = await sql`
    select frozen_prompts from prompt_set_versions
    where id = ${run.promptSetVersionId}
  `;
  if (!version) {
    throw new ClassifiedError("internal", `Run ${runId}: frozen version missing.`);
  }

  await sql`update runs set status = 'running' where id = ${runId}`;

  const allCells = expandCells(
    version.frozenPrompts as FrozenPrompt[],
    run.providers
  );
  const done = await successfulCellKeys(runId);
  const pending = allCells.filter(
    (c) => !done.has(`${c.promptId}|${c.provider}|${c.model}|${c.repetition}`)
  );

  const state: ExecState = {
    cancelled: false,
    budgetExhausted: false,
    spentMicro: await runCostMicroUsd(runId),
    failed: 0,
    launched: 0,
  };
  const budgetMicro = usdToMicro(Number(run.budgetUsd));

  log("info", "run.execute.start", {
    runId,
    totalCells: allCells.length,
    pendingCells: pending.length,
  });

  // Pace by provider. A run mixing providers is bounded by the strictest of
  // them, because one rate-limited provider failing every cell wastes the whole
  // run — the Gemini free tier burned 40 of 40 in six seconds before this.
  const providersInRun = [...new Set(pending.map((cell) => cell.provider))];
  const effectiveConcurrency = concurrencyFor(providersInRun, CONCURRENCY);
  const waitForSlot = createRateGate();

  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(effectiveConcurrency, pending.length) },
    async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        const cell = pending[index];
        if (!cell) return;

        if (state.launched % CANCEL_CHECK_EVERY === 0) {
          const [current] = await sql`
            select status, status_detail from runs where id = ${runId}
          `;
          if (current?.status === "partial" && current.statusDetail === "cancelled") {
            state.cancelled = true;
          }
        }
        if (state.cancelled) return;
        if (state.spentMicro >= budgetMicro) {
          state.budgetExhausted = true;
          return;
        }
        state.launched += 1;
        await waitForSlot(cell.provider);
        await executeCell(runId, cell, state);
      }
    }
  );
  await Promise.all(workers);

  await finalizeRun(runId, allCells.length, state);
}

async function executeCell(
  runId: string,
  cell: Cell,
  state: ExecState
): Promise<void> {
  const provider = getProvider(cell.provider);
  const startedAt = Date.now();
  try {
    const result = await withRetry(() =>
      provider.runPrompt({ model: cell.model, promptText: cell.promptText })
    );
    const micro = costMicroUsd(cell.model, result.tokensIn, result.tokensOut);
    state.spentMicro += micro;

    // An unrecognised payload shape is a parser failure wearing the costume of
    // an empty answer (docs/09). The raw payload is still captured below, so
    // the cell is re-parseable — but it must be loud, or a provider changing
    // its response format looks like a run of models that said nothing.
    if (result.shapeRecognized === false) {
      log("error", "provider.shape_unrecognized", {
        runId,
        provider: cell.provider,
        model: cell.model,
        promptId: cell.promptId,
        note: result.shapeNote ?? "",
      });
    }
    try {
      await sql`
        insert into responses
          (run_id, prompt_id, prompt_text, provider, model, repetition,
           raw_payload, response_text, refusal, latency_ms, tokens_in,
           tokens_out, cost_usd)
        values
          (${runId}, ${cell.promptId}, ${cell.promptText}, ${cell.provider},
           ${cell.model}, ${cell.repetition},
           ${sql.json(result.rawPayload as never)}, ${result.responseText},
           ${result.refusal}, ${Date.now() - startedAt}, ${result.tokensIn},
           ${result.tokensOut}, ${microToUsd(micro)})
      `;
      await sql`
        update runs set cost_usd = cost_usd + ${microToUsd(micro)}
        where id = ${runId}
      `;
    } catch (err) {
      // 23505: another attempt already captured this cell — keep the original
      if (!(typeof err === "object" && err !== null && "code" in err &&
            (err as { code: unknown }).code === "23505")) {
        throw err;
      }
    }
  } catch (err) {
    const classified =
      err instanceof ClassifiedError
        ? err
        : new ClassifiedError("internal", err instanceof Error ? err.message : "Unknown");
    state.failed += 1;
    await sql`
      insert into responses
        (run_id, prompt_id, prompt_text, provider, model, repetition,
         latency_ms, error)
      values
        (${runId}, ${cell.promptId}, ${cell.promptText}, ${cell.provider},
         ${cell.model}, ${cell.repetition}, ${Date.now() - startedAt},
         ${sql.json({ kind: classified.kind, message: classified.message })})
    `;
    log("warn", "run.cell.failed", {
      runId,
      provider: cell.provider,
      model: cell.model,
      kind: classified.kind,
    });
  }
}

async function finalizeRun(
  runId: string,
  totalCells: number,
  state: ExecState
): Promise<void> {
  if (state.cancelled) {
    // cancelRun already set partial/cancelled; just stamp completion
    await sql`
      update runs set completed_at = now() where id = ${runId}
    `;
    log("info", "run.execute.cancelled", { runId });
    return;
  }

  const successes = (await successfulCellKeys(runId)).size;
  let status: "completed" | "partial" | "failed";
  let detail: string | null = null;
  if (state.budgetExhausted) {
    status = "partial";
    detail = "budget cap reached";
  } else if (successes === totalCells) {
    status = "completed";
  } else if (successes === 0) {
    status = "failed";
    detail = "all cells failed";
  } else {
    status = "partial";
    detail = `${totalCells - successes} of ${totalCells} cells failed`;
  }

  await sql`
    update runs set status = ${status}, status_detail = ${detail},
      completed_at = now()
    where id = ${runId}
  `;
  log("info", "run.execute.done", { runId, status, successes, totalCells });

  // Parsing kicks off automatically after execution (spec 004 / docs/07 step 5)
  const { enqueueParseJobs } = await import("@/lib/parsing/service");
  const enqueued = await enqueueParseJobs(runId);
  if (enqueued > 0) log("info", "run.parse_jobs_enqueued", { runId, enqueued });
}
