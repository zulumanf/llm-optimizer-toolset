/**
 * Spec 147 §8.4 — reconciliation of profile-correction requests whose awaited
 * run can never progress. Runs from the worker tick (and at the start of a
 * project's profile checks); advisory-locked, row-locked with skip locked,
 * bounded, stalest first. It reads database state and moves lifecycle columns
 * only: no model, no connector, nothing external. Every move is audited with
 * its prior state, reason and the run/approval/draft/recheck it concerns.
 */
import { sql, type TransactionSql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import {
  closeCorrection,
  failReleasedRecheck,
  lockReconcile,
  reconcileCandidates,
  recordCorrectionDecision,
  reopenForDrafting,
  setCorrectionRoute,
  setDraftStatus,
  type ReconcileRow,
} from "@/db/profile-corrections";
import { log } from "@/lib/logger";
import {
  PROFILE_CHECK_RELEASE_TIMEOUT_MINUTES,
  PROFILE_CORRECTION_STATUS,
  PROFILE_DRAFT_STATUS,
  PROFILE_RECONCILE_BATCH,
} from "@/lib/profile-corrections/constants";
import { reconciliationDecision } from "@/lib/profile-corrections/reconcile-decision";

export interface ReconcileOutcome {
  correctionRequestId: string;
  projectId: string;
  from: string;
  to: string;
  reason: string;
}

export interface ReconcileReport {
  moved: ReconcileOutcome[];
  anomalies: { correctionRequestId: string; note: string }[];
}

const SYSTEM_ACTOR = "system:reconcile";

async function apply(tx: TransactionSql, row: ReconcileRow, now: Date): Promise<ReconcileOutcome | { anomaly: string } | null> {
  const decision = reconciliationDecision(
    {
      status: row.status,
      contentRunState: row.contentRunState,
      contentApprovalDecision: row.contentApprovalDecision,
      routedAt: row.routedAt,
      externalRunState: row.externalRunState,
      draftRunState: row.draftRunState,
      draftAttemptStatus: row.draftStatus,
      recheckRowStatus: row.recheckRowStatus,
      recheckRunState: row.recheckRunState,
      hasRecheckResult: row.hasRecheckResult,
    },
    now,
    PROFILE_CHECK_RELEASE_TIMEOUT_MINUTES
  );
  if (decision.action === "none") return null;
  if (decision.action === "anomaly") return { anomaly: decision.note };

  const S = PROFILE_CORRECTION_STATUS;
  let moved = false;
  if (decision.to === S.rejected) {
    moved =
      row.contentApprovalId !== null &&
      (await recordCorrectionDecision(tx, row.id, {
        from: row.status,
        to: S.rejected,
        approvalId: row.contentApprovalId,
        decidedBy: row.contentApprovalDecidedBy,
        decidedAt: row.contentApprovalDecidedAt ?? now,
        rationale: row.contentApprovalRationale,
      }));
  } else if (decision.to === S.expired || decision.to === S.needsReview) {
    moved = await closeCorrection(tx, row.id, {
      fromStatuses: [row.status],
      to: decision.to,
      closedBy: null,
      reason: decision.reason,
    });
    if (moved && decision.failRecheckRow && row.recheckRowId) {
      await failReleasedRecheck(tx, row.recheckRowId, decision.reason);
    }
  } else if (decision.to === S.destinationRequired) {
    moved = await setCorrectionRoute(tx, row.id, { from: row.status, to: S.destinationRequired, destinationId: null });
  } else if (decision.to === S.readyToDraft) {
    moved = await reopenForDrafting(tx, row.id);
    if (moved && decision.draftOutcomeUnknown && row.activeDraftId) {
      await setDraftStatus(tx, row.activeDraftId, {
        from: [PROFILE_DRAFT_STATUS.created],
        to: PROFILE_DRAFT_STATUS.outcomeUnknown,
        reason: "the send confirmation expired; the Gmail draft may or may not have been sent",
      });
    }
  }
  if (!moved) return null;

  await writeAudit(tx, {
    userId: null,
    action: `profile_correction.${decision.to}`,
    entity: "profile_correction_request",
    entityId: row.id,
    projectId: row.projectId,
    detail: {
      actor: SYSTEM_ACTOR,
      from: row.status,
      to: decision.to,
      reason: decision.reason,
      contentRunId: row.workflowRunId,
      contentRunState: row.contentRunState,
      contentApprovalId: row.contentApprovalId,
      externalRunId: row.externalRunId,
      draftAttemptId: row.activeDraftId,
      draftRunId: row.draftRunId,
      recheckRequestId: row.recheckRowId,
      recheckRunId: row.recheckRunId,
      at: now.toISOString(),
    },
  });
  return { correctionRequestId: row.id, projectId: row.projectId, from: row.status, to: decision.to, reason: decision.reason };
}

/**
 * Reconcile stuck requests — all projects, or one. Idempotent: a request is
 * only selected while its awaited run is stopped, and every move is guarded on
 * the row's current status.
 */
export async function reconcileProfileCorrections(
  opts: { projectId?: string | null; now?: Date; limit?: number } = {}
): Promise<ReconcileReport> {
  const now = opts.now ?? new Date();
  const report = await sql.begin(async (tx) => {
    await lockReconcile(tx);
    const rows = await reconcileCandidates(tx, {
      projectId: opts.projectId ?? null,
      limit: opts.limit ?? PROFILE_RECONCILE_BATCH,
      releaseTimeoutMinutes: PROFILE_CHECK_RELEASE_TIMEOUT_MINUTES,
    });
    const moved: ReconcileOutcome[] = [];
    const anomalies: ReconcileReport["anomalies"] = [];
    for (const row of rows) {
      const result = await apply(tx, row, now);
      if (!result) continue;
      if ("anomaly" in result) anomalies.push({ correctionRequestId: row.id, note: result.anomaly });
      else moved.push(result);
    }
    return { moved, anomalies };
  });
  if (report.moved.length > 0 || report.anomalies.length > 0) {
    log("info", "profile_corrections.reconciled", { moved: report.moved.length, anomalies: report.anomalies.length });
  }
  return report;
}
