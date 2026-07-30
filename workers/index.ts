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
import { discoverAndIngestSite } from "@/lib/knowledge/sources/onboard-site";
import { syncNotifications } from "@/lib/notifications/service";
import { analyzeRun } from "@/lib/gaps/service";
import { analyzeRunAccuracy } from "@/lib/accuracy/service";
import { generateEvidenceExport } from "@/lib/evidence/export";
import { getCurrentUser } from "@/lib/auth";
import { advanceCycle } from "@/lib/cycles/service";
import { compileAffected } from "@/lib/knowledge/build/planner";
// Importing the templates module registers every node handler as a side
// effect — the engine cannot run a graph whose handlers are unknown.
import { bootstrapWorkflows } from "@/lib/workflow/templates";
import { advanceWorkflow } from "@/lib/workflow/engine";
// The automation layer registers ~110 more node handlers and 18 workflow
// definitions on top of spec 018's three (specs/native-automation-and-connector-layer).
import {
  deliverOneEvent,
  ensureAutomationReady,
  runEventDelivery,
  runTriggerDispatch,
} from "@/lib/automation/dispatch";
import { sweepConnections } from "@/lib/connectors/health";
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
  // Crawls a new client's website. Deliberately a job, not part of onboarding:
  // creating the client must not fail because their site is slow or down.
  // Idempotent — ingestSource dedupes on (project, sha256), so a retry after a
  // partial crawl stores nothing twice.
  discover_client_site: async (payload) => {
    await discoverAndIngestSite({
      projectId: payload.projectId as string,
      domain: payload.domain as string,
      createdBy: (payload.createdBy as string | null) ?? null,
    });
  },
  // Long agent/IO operations run here rather than blocking a request:
  // each is idempotent, so a retry after a crash is safe (UX pass).
  analyze_gaps: async (payload) => {
    const user = await getCurrentUser();
    const result = await analyzeRun(user, { runId: payload.runId as string });
    if (!result.ok) throw new Error(result.error.message);
  },
  analyze_accuracy: async (payload) => {
    const user = await getCurrentUser();
    const result = await analyzeRunAccuracy(user, {
      runId: payload.runId as string,
    });
    if (!result.ok) throw new Error(result.error.message);
  },
  // The weekly cycle drives itself one step per tick (spec 017)
  advance_cycle: async (payload) => {
    await advanceCycle(payload.cycleId as string);
  },
  // Incremental knowledge compilation (spec 024). Idempotent by construction:
  // the planner builds only what is stale, and an unchanged page is a no-op, so
  // a duplicate job costs a few queries and mints nothing.
  knowledge_build: async (payload) => {
    await compileAffected({
      projectId: (payload.projectId as string | null) ?? null,
      trigger: (payload.trigger as "event" | "manual" | "maintenance" | "initial") ?? "event",
      triggerRef: (payload.triggerRef as string | null) ?? null,
      slugs: (payload.slugs as string[] | undefined) ?? undefined,
    });
  },
  // One handler drives every workflow graph (spec 018). The tick is
  // re-entrant, so a crashed worker resumes without losing or duplicating
  // node work — the (run, node, fan_key) index is the guarantee.
  advance_workflow: async (payload) => {
    await advanceWorkflow(payload.runId as string);
  },
  build_evidence_export: async (payload) => {
    const user = await getCurrentUser();
    const result = await generateEvidenceExport(user, {
      runId: payload.runId as string,
    });
    if (!result.ok) throw new Error(result.error.message);
  },

  // ---------------------------------------------- automation layer

  // Deliver one event to its subscriptions. Enqueued transactionally by
  // publishEvent, so an event and its delivery attempt cannot diverge.
  deliver_events: async (payload) => {
    await deliverOneEvent(payload.eventId as string);
  },
  // A safety net for events whose delivery job was lost, and the retry path for
  // ones that failed. Idempotent consumption makes re-sweeping harmless.
  sweep_event_delivery: async () => {
    const result = await runEventDelivery(100);
    if (result.deadLettered > 0) {
      log("warn", "worker.events_dead_lettered", { count: result.deadLettered });
    }
  },
  // Fire due schedules and thresholds. Safe at any frequency: a fire key is the
  // window's identity, so two dispatchers on the same slot produce one run.
  dispatch_triggers: async () => {
    await runTriggerDispatch();
  },
  // Probe every connection. Prevents the silent-failure mode where a connector
  // broke weeks ago and reporting has been quietly incomplete since.
  connector_health_sweep: async () => {
    const result = await sweepConnections();
    if (result.failing > 0) {
      log("warn", "worker.connectors_failing", {
        failing: result.failing,
        checked: result.checked,
      });
    }
  },
};

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
