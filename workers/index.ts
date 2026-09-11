/**
 * Background worker (docs/02): polls the Postgres job queue and dispatches
 * handlers. Run with `npm run worker`. Graceful shutdown on SIGINT/SIGTERM —
 * in-flight jobs finish, then the loop exits.
 *
 * The dispatch step itself lives in workers/core.ts so tests can drive it;
 * this file owns only the process concerns: env, signals, polling cadence,
 * bootstrap, and the stale-lease sweep.
 */
// Must be the first import — later imports read env at module load
import { beatHeartbeat } from "@/lib/ops/health";
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { reclaimStaleJobs } from "@/db/jobs";
import { reapOrphanedRuns } from "@/lib/runs/reaper";
import { sql } from "@/db/client";
// Importing the templates module registers every node handler as a side
// effect — the engine cannot run a graph whose handlers are unknown.
import { bootstrapWorkflows } from "@/lib/workflow/templates";
// The automation layer registers ~110 more node handlers and 18 workflow
// definitions on top of spec 018's three (specs/native-automation-and-connector-layer).
import { ensureAutomationReady } from "@/lib/automation/dispatch";
import { runAutomationTick, runWeeklyKick, tickDue } from "@/lib/ops/tick";
import { dispatchOnce } from "@/workers/core";
import { log } from "@/lib/logger";

const WORKER_ID = `worker-${randomUUID().slice(0, 8)}`;
const IDLE_POLL_MS = 2000;
const STALE_LEASE_MINUTES = 15;
/** The platform clock (2026-08-17): the worker is always on, so it ticks the
 * scheduler itself — GitHub's heartbeat workflow is uptime-only now. Every
 * tick runs automation dispatch + the weekly kick (both windowed/idempotent);
 * connector-health probes ride once a day. */
const TICK_INTERVAL_MS = 10 * 60_000;
const HEALTH_INTERVAL_MS = 24 * 60 * 60_000;

let shuttingDown = false;

async function main(): Promise<void> {
  log("info", "worker.start", { workerId: WORKER_ID });
  // Publish workflow definitions before claiming any job: a tick that finds
  // no published version cannot do anything useful.
  await bootstrapWorkflows();
  // Then the automation layer's node handlers, definitions, triggers and
  // subscriptions. Both calls are idempotent.
  await ensureAutomationReady();
  let sinceReclaim = 0;
  let jobsProcessed = 0;
  let lastTickAt: number | null = null;
  let lastHealthAt: number | null = null;

  while (!shuttingDown) {
    // The scheduler tick, before job dispatch so a busy queue cannot starve
    // it. Failures are logged, never fatal: the job loop must outlive a bad
    // tick, and the next interval retries everything (all of it windowed).
    if (tickDue(lastTickAt, Date.now(), TICK_INTERVAL_MS)) {
      lastTickAt = Date.now();
      const includeHealth = tickDue(lastHealthAt, lastTickAt, HEALTH_INTERVAL_MS);
      if (includeHealth) lastHealthAt = lastTickAt;
      try {
        const report = await runAutomationTick({ includeHealth });
        const weekly = await runWeeklyKick();
        log("info", "worker.tick", {
          triggersFired: report.triggers.fired,
          triggersFailed: report.triggers.failed,
          weekly: weekly as never,
          includeHealth,
        });
      } catch (err) {
        log("error", "worker.tick_failed", {
          error: err instanceof Error ? err.message : "unknown",
        });
      }
    }

    const outcome = await dispatchOnce(WORKER_ID);
    if (outcome.status !== "idle") jobsProcessed += 1;
    // The pulse (spec 059): every cycle, working or idle — a dead worker
    // was invisible, and everything asynchronous depends on this loop.
    try {
      await beatHeartbeat(WORKER_ID, jobsProcessed);
    } catch (err) {
      log("error", "worker.heartbeat_failed", {
        error: err instanceof Error ? err.message : "unknown",
      });
    }
    if (outcome.status === "idle") {
      sinceReclaim += 1;
      // Reclaim leases from dead workers roughly once a minute while idle
      if (sinceReclaim * IDLE_POLL_MS >= 60_000) {
        sinceReclaim = 0;
        const reclaimed = await reclaimStaleJobs(STALE_LEASE_MINUTES);
        if (reclaimed > 0) log("warn", "worker.reclaimed_jobs", { reclaimed });
        // After reclaim, so a just-requeued job keeps its run alive: only
        // runs whose execute job is truly gone (dead-lettered) get failed.
        await reapOrphanedRuns();
      }
      await new Promise((r) => setTimeout(r, IDLE_POLL_MS));
    }
  }

  await sql.end();
  log("info", "worker.stop", { workerId: WORKER_ID });
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log("info", "worker.shutdown_requested", { signal });
    shuttingDown = true;
  });
}

main().catch((err) => {
  log("error", "worker.crashed", {
    message: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
