/**
 * Spec 147 slice 4 — the drafting pickup.
 *
 * Every `ready_to_draft` request gets exactly one active drafting attempt.
 * `dispatchCorrectionDrafts` is the ONE way an attempt starts — for requests
 * that just became ready and for any that were ready before drafting existed
 * (the backlog) alike. It runs from the worker tick and from a job enqueued
 * when a request becomes ready, under a transaction-scoped advisory lock:
 *
 *   ready_to_draft, no active attempt → insert attempt (pending) and publish
 *   `profile.correction_ready` (dedupe + run idempotency per attempt).
 *
 * The partial unique index on active attempts makes a second concurrent
 * attempt impossible. An attempt whose run stalled is settled: `pending`
 * (Gmail never called) → failed and retried after a back-off; `creating`
 * (Gmail may have been called) → outcome_unknown and never retried
 * automatically, because a second draft would be a duplicate.
 */
import { randomUUID } from "node:crypto";
import { sql } from "@/db/client";
import {
  enqueueDraftDispatchJob,
  insertDraftAttempt,
  lockDraftDispatch,
  readyForDrafting,
  setDraftEvent,
  settleStalledDraftAttempts,
} from "@/db/profile-corrections";
import { publishEvent } from "@/lib/events/bus";
import { log } from "@/lib/logger";
import {
  PROFILE_CHECK_DISPATCH_INTERVAL_SECONDS,
  PROFILE_CHECK_RELEASE_TIMEOUT_MINUTES,
  PROFILE_CORRECTION_READY_EVENT,
  PROFILE_DRAFT_BATCH,
  PROFILE_DRAFT_RETRY_MINUTES,
  profileDraftIdempotencyKey,
  profileDraftRunKey,
} from "@/lib/profile-corrections/constants";

export interface DraftDispatchReport {
  started: { draftAttemptId: string; correctionRequestId: string }[];
  settled: { id: string; status: string }[];
  failed: { correctionRequestId: string; error: string }[];
  rescheduled: boolean;
}

export async function dispatchCorrectionDrafts(): Promise<DraftDispatchReport> {
  const report = await sql.begin(async (tx) => {
    await lockDraftDispatch(tx);
    const settled = await settleStalledDraftAttempts(tx, PROFILE_CHECK_RELEASE_TIMEOUT_MINUTES);
    const candidates = await readyForDrafting(tx, PROFILE_DRAFT_BATCH, PROFILE_DRAFT_RETRY_MINUTES);

    const started: DraftDispatchReport["started"] = [];
    const failed: DraftDispatchReport["failed"] = [];
    for (const c of candidates) {
      const draftAttemptId = randomUUID();
      try {
        await tx.savepoint(async (sp) => {
          const inserted = await insertDraftAttempt(sp, {
            id: draftAttemptId,
            projectId: c.projectId,
            correctionRequestId: c.id,
            destinationId: c.destinationId,
            requestSha256: c.requestSha256,
            attempt: c.nextAttempt,
            runIdempotencyKey: profileDraftRunKey(draftAttemptId),
          });
          if (!inserted) throw new Error("an active drafting attempt already exists");
          const { event } = await publishEvent(sp, {
            type: PROFILE_CORRECTION_READY_EVENT,
            projectId: c.projectId,
            payload: { correctionRequestId: c.id, destinationId: c.destinationId, draftAttemptId },
            dedupeKey: profileDraftIdempotencyKey(draftAttemptId),
          });
          await setDraftEvent(sp, draftAttemptId, event.id);
        });
        started.push({ draftAttemptId, correctionRequestId: c.id });
      } catch (err) {
        const error = err instanceof Error ? err.message : "unknown";
        failed.push({ correctionRequestId: c.id, error });
        log("warn", "profile_corrections.draft_dispatch_failed", { correctionRequestId: c.id, error });
      }
    }
    const rescheduled =
      candidates.length >= PROFILE_DRAFT_BATCH
        ? await enqueueDraftDispatchJob(tx, PROFILE_CHECK_DISPATCH_INTERVAL_SECONDS)
        : false;
    return { started, settled, failed, rescheduled };
  });
  if (report.started.length > 0 || report.settled.length > 0) {
    log("info", "profile_corrections.drafts_dispatched", {
      started: report.started.length,
      settled: report.settled.length,
      failed: report.failed.length,
    });
  }
  return report;
}
