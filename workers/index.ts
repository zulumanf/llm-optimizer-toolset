/**
 * Background worker (docs/02): polls the Postgres job queue and dispatches
 * handlers. Run with `npm run worker`. Graceful shutdown on SIGINT/SIGTERM —
 * in-flight jobs finish, then the loop exits.
 */
// Must be the first import — later imports read env at module load
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { claimNextJob, completeJob, failJob, reclaimStaleJobs } from "@/db/jobs";
import { sql } from "@/db/client";
import { executeRun } from "@/lib/runs/execute";
import { parseResponse } from "@/lib/parsing/service";
import { computeScores } from "@/lib/scoring/compute";
import { startScheduledRun } from "@/lib/attribution/service";
import { syncNotifications } from "@/lib/notifications/service";
import { log } from "@/lib/logger";

const WORKER_ID = `worker-${randomUUID().slice(0, 8)}`;
const IDLE_POLL_MS = 2000;
const STALE_LEASE_MINUTES = 15;

const handlers: Record<string, (payload: Record<string, unknown>) => Promise<void>> = {
  execute_run: async (payload) => {
    await executeRun(payload.runId as string);
  },
  parse_response: async (payload) => {
    await parseResponse(payload.responseId as string);
  },
  compute_scores: async (payload) => {
    await computeScores(payload.runId as string);
  },
  start_scheduled_run: async (payload) => {
    await startScheduledRun(
      payload as { interventionId: string; offsetLabel: string }
    );
  },
  // Derived from the live attention feed — safe to run on any schedule
  sync_notifications: async () => {
    await syncNotifications();
  },
};

let shuttingDown = false;

async function main(): Promise<void> {
  log("info", "worker.start", { workerId: WORKER_ID });
  let sinceReclaim = 0;

  while (!shuttingDown) {
    const job = await claimNextJob(WORKER_ID);
    if (!job) {
      sinceReclaim += 1;
      // Reclaim leases from dead workers roughly once a minute while idle
      if (sinceReclaim * IDLE_POLL_MS >= 60_000) {
        sinceReclaim = 0;
        const reclaimed = await reclaimStaleJobs(STALE_LEASE_MINUTES);
        if (reclaimed > 0) log("warn", "worker.reclaimed_jobs", { reclaimed });
      }
      await new Promise((r) => setTimeout(r, IDLE_POLL_MS));
      continue;
    }

    log("info", "worker.job.claimed", { jobId: job.id, type: job.type });
    const handler = handlers[job.type];
    if (!handler) {
      await failJob(job, `No handler for job type: ${job.type}`);
      continue;
    }
    try {
      await handler(job.payload);
      await completeJob(job.id);
      log("info", "worker.job.done", { jobId: job.id });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      await failJob(job, message);
      log("error", "worker.job.failed", {
        jobId: job.id,
        attempts: job.attempts,
        message,
      });
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
