/**
 * Spec 147 §3.3 — the bounded profile-check dispatcher.
 *
 * Releases queued checks oldest first, but never more than the global
 * inference bound allows: at most PROFILE_CHECK_MAX_INFERENCE_RUNS profile
 * runs may be able to call a local model at once, across every client. Runs
 * parked for approval and terminal runs do not count. The bound does not rely
 * on the worker happening to run one job at a time — it holds with any number
 * of workers, because the capacity check and the release happen under one
 * transaction-scoped advisory lock.
 *
 * Called by the `profile_check_dispatch` job (re-enqueued while due work
 * waits) and by every worker tick as the safety net.
 */
import { sql } from "@/db/client";
import {
  claimDueChecks,
  countInferenceActive,
  enqueueDispatchJob,
  failAbandonedReleases,
  hasDueQueuedChecks,
  lockDispatch,
  markFailed,
  markReleased,
  markSkipped,
} from "@/db/profile-corrections";
import { PROFILE_CORRECTION_KEY } from "@/lib/automation/workflows/authority";
import { publishEvent } from "@/lib/events/bus";
import { log } from "@/lib/logger";
import { profileCheckMaxInferenceRuns } from "@/lib/profile-corrections/config";
import {
  PROFILE_CHECK_DISPATCH_INTERVAL_SECONDS,
  PROFILE_CHECK_RELEASE_SKIP,
  PROFILE_CHECK_RELEASE_TIMEOUT_MINUTES,
  PROFILE_CHECK_REQUESTED_EVENT,
  profileCheckIdempotencyKey,
} from "@/lib/profile-corrections/constants";

const ACTIVE_PROJECT_STATUS = "active";
const MAX_REASON_LENGTH = 500;

/** Workflows whose runs hold local inference while active. */
export const PROFILE_INFERENCE_WORKFLOW_KEYS = [PROFILE_CORRECTION_KEY] as const;

export interface DispatchReport {
  limit: number;
  activeBefore: number;
  released: string[];
  skipped: { id: string; reason: string }[];
  abandoned: string[];
  rescheduled: boolean;
}

export async function dispatchProfileChecks(): Promise<DispatchReport> {
  // An invalid configured bound throws here, before anything is released.
  const limit = profileCheckMaxInferenceRuns();

  const report = await sql.begin(async (tx) => {
    await lockDispatch(tx);

    const abandoned = await failAbandonedReleases(tx, PROFILE_CHECK_RELEASE_TIMEOUT_MINUTES);
    for (const row of abandoned) {
      log("warn", "profile_checks.release_abandoned", { checkRequestId: row.id, projectId: row.projectId });
    }

    const activeBefore = await countInferenceActive(tx, PROFILE_INFERENCE_WORKFLOW_KEYS);
    const capacity = Math.max(0, limit - activeBefore);
    const due = await claimDueChecks(tx, capacity);

    const released: string[] = [];
    const skipped: { id: string; reason: string }[] = [];
    for (const row of due) {
      if (row.projectStatus !== ACTIVE_PROJECT_STATUS) {
        await markSkipped(tx, row.id, PROFILE_CHECK_RELEASE_SKIP.projectInactive);
        skipped.push({ id: row.id, reason: PROFILE_CHECK_RELEASE_SKIP.projectInactive });
        continue;
      }
      // A savepoint per row: one row that cannot be published is closed as
      // failed instead of rolling back (and forever blocking) the whole queue.
      try {
        await tx.savepoint(async (sp) => {
          const { event } = await publishEvent(sp, {
            type: PROFILE_CHECK_REQUESTED_EVENT,
            projectId: row.projectId,
            payload: {
              checkRequestId: row.id,
              contextItemId: row.contextItemId,
              profileUrl: row.profileUrl,
              origin: row.origin,
              window: row.windowKey,
            },
            dedupeKey: profileCheckIdempotencyKey(row.projectId, row.id),
          });
          await markReleased(sp, row.id, event.id);
        });
        released.push(row.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : "unknown";
        const reason = `${PROFILE_CHECK_RELEASE_SKIP.publishFailed}: ${message}`.slice(0, MAX_REASON_LENGTH);
        await markFailed(tx, row.id, reason);
        skipped.push({ id: row.id, reason });
        log("warn", "profile_checks.release_failed", { checkRequestId: row.id, projectId: row.projectId, error: message });
      }
    }

    // Keep draining while due work waits; the tick is only the safety net.
    const rescheduled = (await hasDueQueuedChecks(tx))
      ? await enqueueDispatchJob(tx, PROFILE_CHECK_DISPATCH_INTERVAL_SECONDS)
      : false;

    return {
      limit,
      activeBefore,
      released,
      skipped,
      abandoned: abandoned.map((a) => a.id),
      rescheduled,
    };
  });

  if (report.released.length > 0 || report.abandoned.length > 0) {
    log("info", "profile_checks.dispatched", {
      limit: report.limit,
      activeBefore: report.activeBefore,
      released: report.released.length,
      skipped: report.skipped.length,
      abandoned: report.abandoned.length,
    });
  }
  return report;
}
