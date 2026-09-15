/**
 * The worker's dispatch core, separated from the process shell so tests can
 * drive it (A5: the loop that decides when work re-runs was the one layer
 * with no test seam). `workers/index.ts` owns the process concerns — env
 * loading, signals, polling cadence, stale-lease sweeps; this module owns
 * what a single claim-dispatch-settle step does.
 */
import { claimNextJob, completeJob, failJob } from "@/db/jobs";
import { executeRun } from "@/lib/runs/execute";
import { parseResponse } from "@/lib/parsing/service";
import { computeScores } from "@/lib/scoring/compute";
import { startScheduledRun } from "@/lib/attribution/service";
import { discoverAndIngestSite } from "@/lib/knowledge/sources/onboard-site";
import { syncNotifications } from "@/lib/notifications/service";
import { analyzeRun } from "@/lib/gaps/service";
import { extractClaimsFromSource } from "@/lib/knowledge/extraction/claims";
import { runExternalDiscovery } from "@/lib/knowledge/discovery/service";
import { analyzeRunAccuracy } from "@/lib/accuracy/service";
import { generateEvidenceExport } from "@/lib/evidence/export";
import { systemUser } from "@/lib/auth";
import { advanceCycle } from "@/lib/cycles/service";
import { compileAffected } from "@/lib/knowledge/build/planner";
import { advanceWorkflow } from "@/lib/workflow/engine";
import {
  deliverOneEvent,
  runEventDelivery,
  runTriggerDispatch,
} from "@/lib/automation/dispatch";
import { sweepConnections } from "@/lib/connectors/health";
import { log } from "@/lib/logger";

export const handlers: Record<
  string,
  (payload: Record<string, unknown>) => Promise<void>
> = {
  execute_run: async (payload) => {
    await executeRun(payload.runId as string);
  },
  parse_response: async (payload) => {
    await parseResponse(payload.responseId as string, { reparse: payload.reparse === true });
  },
  backfill_company: async (payload) => {
    const { runCompanyBackfill } = await import("@/lib/parsing/backfill");
    await runCompanyBackfill(payload as unknown as import("@/lib/parsing/backfill").BackfillPayload);
  },
  compute_scores: async (payload) => {
    await computeScores(payload.runId as string);
  },
  start_scheduled_run: async (payload) => {
    await startScheduledRun(
      payload as { interventionId: string; offsetLabel: string }
    );
  },
  // Spec 138: render one personalized video walkthrough revision (script →
  // narration → stills → MP4 → QA); idempotent on the artifact's generation
  // key, never delivers.
  render_video_walkthrough: async (payload) => {
    const { processVideoWalkthroughJob } = await import("@/lib/prospects/video-walkthrough");
    await processVideoWalkthroughJob(payload.artifactId as string, { workerId: process.env.WORKER_ID ?? null });
  },
  // Spec 051: fetch each shipped intervention URL through safeFetch and
  // record the result — "it actually shipped" becomes a database fact.
  verify_intervention_urls: async (payload) => {
    const { verifyInterventionUrls } = await import("@/lib/attribution/verify-urls");
    await verifyInterventionUrls(payload.interventionId as string);
  },
  // Spec 060: fetch a citation source page and record whether the client and
  // competitors appear on it — presence becomes a measured, append-only fact.
  check_source_presence: async (payload) => {
    const { runPresenceCheck } = await import("@/lib/citations/service");
    await runPresenceCheck(
      payload as {
        projectId: string;
        domain: string;
        url: string;
        checkedBy?: string | null;
      }
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
  // Spec 088: technical discoverability scan of the client's own domain —
  // robots, sitemaps, per-page facts, findings. A failed scan records its
  // own 'failed' row; a retry starts a fresh scan, never mutating history.
  technical_scan: async (payload) => {
    const { runTechnicalScan } = await import("@/lib/discoverability/scan");
    await runTechnicalScan({
      projectId: payload.projectId as string,
      startedBy: (payload.startedBy as string | null) ?? null,
    });
  },
  // Long agent/IO operations run here rather than blocking a request:
  // each is idempotent, so a retry after a crash is safe (UX pass).
  analyze_gaps: async (payload) => {
    const user = await systemUser();
    const result = await analyzeRun(user, { runId: payload.runId as string });
    if (!result.ok) throw new Error(result.error.message);
  },
  analyze_accuracy: async (payload) => {
    const user = await systemUser();
    const result = await analyzeRunAccuracy(user, {
      runId: payload.runId as string,
    });
    if (!result.ok) throw new Error(result.error.message);
  },
  // The weekly cycle drives itself one step per tick (spec 017)
  advance_cycle: async (payload) => {
    await advanceCycle(payload.cycleId as string);
  },
  // LLM claim extraction from an ingested source (D3). Runs as a job so an
  // upload returns immediately; verbatim-quote guarding and proposed-only
  // writes live in the extractor. Idempotent enough to retry: re-extracting
  // proposes duplicates the operator rejects, it never auto-approves.
  extract_claims: async (payload) => {
    const user = await systemUser();
    const result = await extractClaimsFromSource(user, {
      sourceArtifactId: payload.sourceArtifactId as string,
    });
    if (!result.ok) throw new Error(result.error.message);
  },
  // External discovery (spec 027, wired per spec 036 follow-through). The
  // service records its own discovery_runs row incl. failures; a thrown
  // error here marks the JOB failed for retry, while a run that completed
  // with a stop_reason is a success whose summary says why it stopped.
  external_discovery: async (payload) => {
    const user = await systemUser();
    const result = await runExternalDiscovery(user, {
      projectId: payload.projectId as string,
    });
    if (!result.ok) throw new Error(result.error.message);
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
    const user = await systemUser();
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
  // Sweep undelivered/failed events. NOTE: nothing in production enqueues
  // this — the worker tick calls runEventDelivery directly every 10 minutes
  // (lib/ops/tick.ts), which IS the safety net. This queue path exists for
  // manual re-runs and the dispatch tests. Idempotent; re-sweeping harmless.
  sweep_event_delivery: async () => {
    const result = await runEventDelivery(100);
    if (result.deadLettered > 0) {
      log("warn", "worker.events_dead_lettered", { count: result.deadLettered });
    }
  },
  // Fire due schedules and thresholds. Like sweep_event_delivery, production
  // runs this inline from the tick — the queue path is for manual re-runs.
  // Safe at any frequency: a fire key is the window's identity, so two
  // dispatchers on the same slot produce one run.
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

export type DispatchOutcome =
  | { status: "idle" }
  | { status: "done" | "failed"; jobId: string; type: string };

/**
 * Claim and settle exactly one job. This is the whole contract of a worker
 * step: an unknown type or a thrown handler fails the job (requeue with
 * backoff until JOB_MAX_ATTEMPTS, then dead-letter); success completes it.
 */
export async function dispatchOnce(workerId: string): Promise<DispatchOutcome> {
  const job = await claimNextJob(workerId);
  if (!job) return { status: "idle" };

  log("info", "worker.job.claimed", { jobId: job.id, type: job.type });
  const handler = handlers[job.type];
  if (!handler) {
    await failJob(job, `No handler for job type: ${job.type}`);
    return { status: "failed", jobId: job.id, type: job.type };
  }
  try {
    await handler(job.payload);
    await completeJob(job.id);
    log("info", "worker.job.done", { jobId: job.id });
    return { status: "done", jobId: job.id, type: job.type };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    await failJob(job, message);
    log("error", "worker.job.failed", {
      jobId: job.id,
      attempts: job.attempts,
      message,
    });
    return { status: "failed", jobId: job.id, type: job.type };
  }
}
