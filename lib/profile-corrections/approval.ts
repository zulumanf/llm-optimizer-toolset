/**
 * Spec 147 §7 — the correction side of a human decision, and withdrawal.
 *
 * `applyCorrectionDecision` runs inside the one approval-decision transaction
 * (app/workflows/actions.ts → decideApprovalAction). A rejection is persisted
 * on the correction row atomically with the decision; an approval is refused
 * outright if what the human saw is not the stored request (hash binding).
 * Marking a request approved happens after the gate, in
 * `dom.record_profile_correction_approval`, which also re-proves the facts.
 */
import { z } from "zod";
import { sql, type TransactionSql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import {
  activeDestination,
  approvalById,
  closeCorrection,
  correctionById,
  correctionForRun,
  lockCorrection,
  lockDraft,
  openRunsForCorrection,
  recordCorrectionDecision,
  runPayloadValue,
  setCorrectionRoute,
  setDraftStatus,
  skipQueuedRecheck,
  supersedePendingDrafts,
  type ApprovalRow,
} from "@/db/profile-corrections";
import { fail, ok, type ActionResult } from "@/lib/actions/result";
import { cancelWorkflow } from "@/lib/automation/runtime";
import { assertProjectAccess, assertRole, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { firstZodMessage } from "@/lib/service-helpers";
import {
  approvalBindingError,
  externalApprovalBindingError,
  sendConfirmationBindingError,
} from "@/lib/profile-corrections/approval-binding";
import {
  EXTERNAL_SUBMISSION_APPROVAL_NODE,
  PROFILE_CORRECTION_APPROVAL_NODE,
  PROFILE_DRAFT_STATUS,
  SEND_CONFIRMATION_NODE,
  PROFILE_CORRECTION_STATUS,
  WITHDRAWABLE_CORRECTION_STATUSES,
} from "@/lib/profile-corrections/constants";

export async function applyCorrectionDecision(
  tx: TransactionSql,
  args: { approvalId: string; decision: "approved" | "rejected"; decidedBy: string; rationale: string }
): Promise<void> {
  const approval = await approvalById(tx, args.approvalId);
  if (!approval || approval.projectId === null) return;
  if (approval.nodeKey === EXTERNAL_SUBMISSION_APPROVAL_NODE) {
    await applyExternalSubmissionDecision(tx, approval, args);
    return;
  }
  if (approval.nodeKey === SEND_CONFIRMATION_NODE) {
    await applySendConfirmationDecision(tx, approval, args);
    return;
  }
  if (approval.nodeKey !== PROFILE_CORRECTION_APPROVAL_NODE) return;
  const row = await correctionForRun(tx, approval.workflowRunId, approval.projectId);
  if (!row || row.status !== PROFILE_CORRECTION_STATUS.awaitingApproval) return;

  if (args.decision === "approved") {
    const binding = approvalBindingError(approval.detail, row.requestSha256);
    if (binding) {
      throw new ClassifiedError(
        "conflict",
        `This approval cannot be recorded: ${binding}. Re-run the profile check to build a new request.`
      );
    }
    return;
  }

  const moved = await recordCorrectionDecision(tx, row.id, {
    from: PROFILE_CORRECTION_STATUS.awaitingApproval,
    to: PROFILE_CORRECTION_STATUS.rejected,
    approvalId: approval.id,
    decidedBy: args.decidedBy,
    decidedAt: new Date(),
    rationale: args.rationale,
  });
  if (moved) {
    await writeAudit(tx, {
      userId: args.decidedBy,
      action: `profile_correction.${PROFILE_CORRECTION_STATUS.rejected}`,
      entity: "profile_correction_request",
      entityId: row.id,
      projectId: row.projectId,
      detail: { approvalId: approval.id, requestSha256: row.requestSha256, rationale: args.rationale },
    });
  }
}

/**
 * The publisher authorization gate (spec 147 slice 3). An approval must bind
 * to the request hash and the destination shown; a rejection sends the
 * request back to `destination_required` with the decision audited, so an
 * operator can record a different destination.
 */
async function applyExternalSubmissionDecision(
  tx: TransactionSql,
  approval: ApprovalRow,
  args: { decision: "approved" | "rejected"; decidedBy: string; rationale: string }
): Promise<void> {
  const correctionRequestId = await runPayloadValue(tx, approval.workflowRunId, "correctionRequestId");
  if (!correctionRequestId || approval.projectId === null) return;
  const row = await lockCorrection(tx, correctionRequestId, approval.projectId);
  if (!row || row.status !== PROFILE_CORRECTION_STATUS.awaitingExternalApproval) return;

  if (args.decision === "approved") {
    const binding = externalApprovalBindingError(approval.detail, row.requestSha256, row.destinationId);
    if (binding) {
      throw new ClassifiedError(
        "conflict",
        `This external-submission approval cannot be recorded: ${binding}.`
      );
    }
    return;
  }

  const moved = await setCorrectionRoute(tx, row.id, {
    from: PROFILE_CORRECTION_STATUS.awaitingExternalApproval,
    to: PROFILE_CORRECTION_STATUS.destinationRequired,
    destinationId: null,
  });
  if (moved) {
    await writeAudit(tx, {
      userId: args.decidedBy,
      action: "profile_correction.external_submission_rejected",
      entity: "profile_correction_request",
      entityId: row.id,
      projectId: row.projectId,
      detail: { approvalId: approval.id, destinationId: row.destinationId, rationale: args.rationale },
    });
  }
}

/**
 * The send confirmation (spec 147 slice 4). Confirming binds to the request,
 * its hash, the destination — which must still be the active one — and the
 * exact Gmail draft; anything stale is refused with the decision. Declining
 * ("I will not send this") closes the request as withdrawn and discards the
 * draft attempt; an operator deletes the draft in Gmail.
 */
async function applySendConfirmationDecision(
  tx: TransactionSql,
  approval: ApprovalRow,
  args: { decision: "approved" | "rejected"; decidedBy: string; rationale: string }
): Promise<void> {
  if (approval.projectId === null) return;
  const correctionRequestId = await runPayloadValue(tx, approval.workflowRunId, "correctionRequestId");
  const draftAttemptId = await runPayloadValue(tx, approval.workflowRunId, "draftAttemptId");
  if (!correctionRequestId || !draftAttemptId) return;
  const row = await lockCorrection(tx, correctionRequestId, approval.projectId);
  const draft = await lockDraft(tx, draftAttemptId, approval.projectId);
  if (!row || !draft || row.status !== PROFILE_CORRECTION_STATUS.awaitingSendConfirmation) return;

  if (args.decision === "approved") {
    const binding = sendConfirmationBindingError(approval.detail, {
      correctionRequestId: row.id,
      requestSha256: row.requestSha256,
      destinationId: draft.destinationId,
      draftAttemptId: draft.id,
      gmailDraftId: draft.gmailDraftId,
    });
    const active = await activeDestination(tx, row.projectId, row.profileUrl);
    const stale =
      binding ??
      (row.activeDraftId !== draft.id ? "this is not the request's current draft" : null) ??
      (!active || active.id !== draft.destinationId
        ? "the destination this draft was addressed to is no longer the active one"
        : null);
    if (stale) {
      throw new ClassifiedError("conflict", `This send confirmation cannot be recorded: ${stale}.`);
    }
    return;
  }

  const closed = await closeCorrection(tx, row.id, {
    fromStatuses: [PROFILE_CORRECTION_STATUS.awaitingSendConfirmation],
    to: PROFILE_CORRECTION_STATUS.withdrawn,
    closedBy: args.decidedBy,
    reason: `send not confirmed: ${args.rationale}`,
  });
  await setDraftStatus(tx, draft.id, {
    from: [PROFILE_DRAFT_STATUS.created],
    to: PROFILE_DRAFT_STATUS.discarded,
    reason: `send not confirmed; delete Gmail draft ${draft.gmailDraftId ?? ""}`.trim(),
  });
  if (closed) {
    await writeAudit(tx, {
      userId: args.decidedBy,
      action: `profile_correction.${PROFILE_CORRECTION_STATUS.withdrawn}`,
      entity: "profile_correction_request",
      entityId: row.id,
      projectId: row.projectId,
      detail: { approvalId: approval.id, draftAttemptId: draft.id, gmailDraftId: draft.gmailDraftId, rationale: args.rationale },
    });
  }
}

const withdrawSchema = z.object({
  projectId: z.string().uuid(),
  correctionRequestId: z.string().uuid(),
  reason: z.string().trim().min(3).max(1000),
});

/** An operator closes a request that has not left the platform. */
export async function withdrawCorrectionRequest(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ correctionRequestId: string; status: string }>> {
  const parsed = withdrawSchema.safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  const input = parsed.data;
  try {
    assertRole(user, "operator");
    await assertProjectAccess(user, input.projectId);
    const row = await correctionById(sql, input.correctionRequestId);
    if (!row || row.projectId !== input.projectId) {
      throw new ClassifiedError("not_found", "Correction request not found.");
    }
    const withdrawn = await sql.begin(async (tx) => {
      const okMove = await closeCorrection(tx, row.id, {
        fromStatuses: WITHDRAWABLE_CORRECTION_STATUSES,
        to: PROFILE_CORRECTION_STATUS.withdrawn,
        closedBy: user.id,
        reason: input.reason,
      });
      if (okMove) {
        // Neutralize internal work that would otherwise still run. History is
        // kept: attempts change status, nothing is deleted, and a Gmail draft
        // is never deleted or sent by the platform.
        const superseded = await supersedePendingDrafts(tx, row.id);
        const discarded = row.activeDraftId
          ? await setDraftStatus(tx, row.activeDraftId, {
              from: [PROFILE_DRAFT_STATUS.created],
              to: PROFILE_DRAFT_STATUS.discarded,
              reason: "request withdrawn; delete the Gmail draft manually if it was not sent",
            })
          : false;
        const rechecksSkipped = await skipQueuedRecheck(tx, row.id, "request withdrawn");
        await writeAudit(tx, {
          userId: user.id,
          action: `profile_correction.${PROFILE_CORRECTION_STATUS.withdrawn}`,
          entity: "profile_correction_request",
          entityId: row.id,
          projectId: row.projectId,
          detail: {
            from: row.status,
            reason: input.reason,
            pendingDraftsSuperseded: superseded,
            activeDraftDiscarded: discarded ? row.activeDraftId : null,
            rechecksSkipped,
          },
        });
      }
      return okMove;
    });
    if (!withdrawn) {
      throw new ClassifiedError("conflict", `This correction request is ${row.status} and cannot be withdrawn.`);
    }
    // Runs still waiting on this request (an approval gate, a draft) are
    // cancelled so nothing is left asking a human about a withdrawn request.
    // Best effort: a run that settles meanwhile is simply skipped, and every
    // later step of any run re-checks the request's status and fails closed.
    for (const open of await openRunsForCorrection(sql, row.id)) {
      try {
        await cancelWorkflow(open.id, `profile correction ${row.id} withdrawn`, user.id);
      } catch {
        // Already terminal: nothing to cancel.
      }
    }
    return ok({ correctionRequestId: row.id, status: PROFILE_CORRECTION_STATUS.withdrawn });
  } catch (err) {
    return fail(err);
  }
}
