/**
 * Run executor — the worker's execute_run handler (spec 003, docs/07 steps 3-4).
 * Idempotent and resumable: cells with a successful capture are skipped, so a
 * crashed or retried run continues without duplicating data (the partial
 * unique index is the backstop). Raw payloads are captured before anything
 * else touches them; failed calls are captured with their classified error.
 */
import { sql } from "@/db/client";
import {
  getRun,
  successfulCellKeys,
  runCostMicroUsd,
  spendLast24hUsd,
} from "@/db/runs";
import { DAILY_SPEND_CEILING_USD } from "@/lib/constants";
import type { FrozenPrompt } from "@/lib/prompts/types";
import { getProvider } from "@/lib/ai/registry";
import { withRetry } from "@/lib/ai/retry";
import { costMicroUsd, microToUsd, usdToMicro } from "@/lib/ai/pricing";
import { ClassifiedError } from "@/lib/errors";
import { log } from "@/lib/logger";
import { expandCells, type Cell } from "@/lib/runs/cells";
import { concurrencyFor, sharedRateGate } from "@/lib/ai/limits";

/** Ceiling. The effective figure is the lowest limit among the run's providers. */
const CONCURRENCY = 4;
const CANCEL_CHECK_EVERY = 5;

interface ExecState {
  cancelled: boolean;
  budgetExhausted: boolean;
  /**
   * Set when a provider says its quota is spent for the window. Every
   * remaining cell for that provider would fail, so the run stops rather than
   * working through them one failure at a time — a Gemini run burned 20 cells
   * this way before the distinction existed.
   */
  quotaExhausted: string | null;
  /**
   * Set when a successful call could not be priced (pricing row vanished
   * mid-run — validation makes this unreachable at run creation). The
   * payload is captured with cost_usd NULL, then the run stops: continuing
   * would spend money the budget cap cannot see.
   */
  unpricedModel: string | null;
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

  // Portfolio ceiling backstop (plan 2.7) — scheduled runs reach here
  // without passing startRun's check. A ceiling hit is a terminal state
  // with a reason, not a retry loop.
  const spent = await spendLast24hUsd();
  if (spent >= DAILY_SPEND_CEILING_USD) {
    await sql`
      update runs set status = 'failed',
        status_detail = ${`portfolio spend ceiling reached ($${spent.toFixed(2)} of $${DAILY_SPEND_CEILING_USD} in 24h) — retry the run once the window clears`},
        completed_at = now()
      where id = ${runId}
    `;
    log("error", "run.spend_ceiling_hit", { runId, spent });
    return;
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
    quotaExhausted: null,
    unpricedModel: null,
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
  const waitForSlot = sharedRateGate;

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
        if (state.quotaExhausted !== null) return;
        if (state.unpricedModel !== null) return;
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
    // Priced AFTER the call but never at the expense of the capture: a
    // pricing gap must not discard a successful payload (docblock contract).
    // cost NULL = "unpriced, run halted", never $0 (plan 2.6).
    let micro: number | null;
    try {
      micro = costMicroUsd(cell.model, result.tokensIn, result.tokensOut);
      state.spentMicro += micro;
    } catch (pricingErr) {
      micro = null;
      state.unpricedModel = cell.model;
      log("error", "run.cell_unpriced", {
        runId,
        model: cell.model,
        message:
          pricingErr instanceof Error ? pricingErr.message.slice(0, 200) : "unknown",
      });
    }

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
      // Capture and cost commit together (correctness audit 2026-08-04):
      // separately, a failure between them either lost the cell's cost from
      // the budget cap's ledger, or — worse — let the outer catch insert an
      // error row for a cell that was already captured (the success unique
      // index is partial on `error is null`, so it cannot block that), and
      // responses is insert-only, so the double state was unrepairable.
      await sql.begin(async (tx) => {
        await tx`
          insert into responses
            (run_id, prompt_id, prompt_text, provider, model, repetition,
             raw_payload, response_text, refusal, latency_ms, tokens_in,
             tokens_out, cost_usd)
          values
            (${runId}, ${cell.promptId}, ${cell.promptText}, ${cell.provider},
             ${cell.model}, ${cell.repetition},
             ${tx.json(result.rawPayload as never)}, ${result.responseText},
             ${result.refusal}, ${Date.now() - startedAt}, ${result.tokensIn},
             ${result.tokensOut}, ${micro === null ? null : microToUsd(micro)})
        `;
        if (micro !== null) {
          await tx`
            update runs set cost_usd = cost_usd + ${microToUsd(micro)}
            where id = ${runId}
          `;
        }
      });
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
    if (classified.kind === "provider_quota_exhausted" && state.quotaExhausted === null) {
      // First cell to hit it stops the run. The failure is still recorded —
      // a failed cell is evidence, and PRINCIPLES #5 forbids pretending
      // otherwise — but no further calls are made against a spent quota.
      state.quotaExhausted = cell.provider;
      log("warn", "run.quota_exhausted", {
        runId,
        provider: cell.provider,
        model: cell.model,
        message: classified.message.slice(0, 200),
      });
    }
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
  if (state.quotaExhausted) {
    // Named explicitly: "20 of 40 cells failed" reads as flaky, while
    // "provider quota exhausted" tells the operator to come back tomorrow or
    // enable billing.
    status = successes === 0 ? "failed" : "partial";
    detail = `provider quota exhausted (${state.quotaExhausted}) — ${successes} of ${totalCells} cells captured before stopping`;
  } else if (state.unpricedModel) {
    status = successes === totalCells ? "completed" : "partial";
    detail = `model "${state.unpricedModel}" lost its pricing entry mid-run — captures kept (cost recorded as unknown), remaining cells skipped`;
  } else if (state.budgetExhausted) {
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

  // Status and lifecycle event commit together (the bus's design point:
  // an event cannot exist for a write that rolled back). These events were
  // declared in the catalogue since migration 020 with no producer — the
  // exact "promise, not a contract" the catalogue docblock warns about.
  const { publishEvent } = await import("@/lib/events/bus");
  const [run] = await sql`
    select project_id, prompt_set_version_id from runs where id = ${runId}
  `;
  await sql.begin(async (tx) => {
    await tx`
      update runs set status = ${status}, status_detail = ${detail},
        completed_at = now()
      where id = ${runId}
    `;
    await publishEvent(tx, {
      type:
        status === "completed" ? "benchmark.completed" : "benchmark.partially_failed",
      projectId: (run?.projectId as string) ?? null,
      payload: {
        runId,
        promptSetVersionId: (run?.promptSetVersionId as string) ?? undefined,
        cellsTotal: totalCells,
        cellsSucceeded: successes,
      },
      dedupeKey: `benchmark-final:${runId}`,
    });
  });
  log("info", "run.execute.done", { runId, status, successes, totalCells });

  // Parsing kicks off automatically after execution (spec 004 / docs/07 step 5)
  const { enqueueParseJobs } = await import("@/lib/parsing/service");
  const enqueued = await enqueueParseJobs(runId);
  if (enqueued > 0) log("info", "run.parse_jobs_enqueued", { runId, enqueued });
}
