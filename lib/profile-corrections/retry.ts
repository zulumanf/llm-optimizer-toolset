/**
 * Spec 147 slice 6 — an operator-confirmed retry of an uncertain Gmail draft.
 *
 * An attempt whose outcome is unknown, or that was orphaned, may already have
 * produced a Gmail draft (or, after an expired send confirmation, even a sent
 * email). It is never retried automatically. An operator may retry it only by
 * confirming they checked Gmail and no usable draft exists, and only against
 * the request's CURRENT hash and active destination; anything else needs the
 * normal routing first. The uncertain attempt is superseded — kept, with its
 * Gmail ids — and exactly one new attempt is queued. Repeating the retry for
 * the same attempt returns the attempt it already created.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import {
  activeDestination,
  correctionById,
  insertRetryAttempt,
  lockCorrection,
  lockDraft,
  lockProfileDestination,
  retryOfAttempt,
  setDraftEvent,
  setDraftStatus,
} from "@/db/profile-corrections";
import { fail, ok, type ActionResult } from "@/lib/actions/result";
import { assertProjectAccess, assertRole, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { publishEvent } from "@/lib/events/bus";
import { firstZodMessage } from "@/lib/service-helpers";
import {
  PROFILE_CORRECTION_READY_EVENT,
  PROFILE_CORRECTION_STATUS,
  PROFILE_DRAFT_MAX_AUTO_ATTEMPTS,
  PROFILE_DRAFT_STATUS,
  profileDraftIdempotencyKey,
  profileDraftRunKey,
} from "@/lib/profile-corrections/constants";
import { contentApprovalError } from "@/lib/profile-corrections/routing";

/** Only these attempts need an operator to unblock them. */
const RETRYABLE_ATTEMPT_STATUSES = [PROFILE_DRAFT_STATUS.outcomeUnknown, PROFILE_DRAFT_STATUS.orphaned] as const;

const retrySchema = z
  .object({
    projectId: z.string().uuid(),
    correctionRequestId: z.string().uuid(),
    draftAttemptId: z.string().uuid(),
    /** The request hash and destination the operator is retrying against. */
    expectedRequestSha256: z.string().regex(/^[0-9a-f]{64}$/),
    expectedDestinationId: z.string().uuid(),
    /** The operator checked Gmail: no usable draft exists for this attempt. */
    confirmNoUsableDraft: z.literal(true),
    reason: z.string().trim().min(3).max(1000),
  })
  .strict();

export interface RetryResult {
  draftAttemptId: string;
  retriedAttemptId: string;
  created: boolean;
}

export async function retryProfileCorrectionDraft(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<RetryResult>> {
  const parsed = retrySchema.safeParse(raw);
  if (!parsed.success) {
    return fail(
      new ClassifiedError(
        "validation",
        parsed.error.issues.some((i) => i.path[0] === "confirmNoUsableDraft")
          ? "Confirm that you checked Gmail and no usable draft exists before retrying."
          : firstZodMessage(parsed.error)
      )
    );
  }
  const input = parsed.data;
  try {
    assertRole(user, "operator");
    await assertProjectAccess(user, input.projectId);
    const peek = await correctionById(sql, input.correctionRequestId);
    if (!peek || peek.projectId !== input.projectId) {
      throw new ClassifiedError("not_found", "Correction request not found.");
    }

    const result = await sql.begin(async (tx): Promise<RetryResult> => {
      await lockProfileDestination(tx, input.projectId, peek.profileUrl);
      const row = await lockCorrection(tx, input.correctionRequestId, input.projectId);
      const attempt = await lockDraft(tx, input.draftAttemptId, input.projectId);
      if (!row || !attempt || attempt.correctionRequestId !== row.id) {
        throw new ClassifiedError("not_found", "Draft attempt not found for this correction request.");
      }

      // A repeated retry of the same attempt is the same retry.
      const existing = await retryOfAttempt(tx, attempt.id);
      if (existing) return { draftAttemptId: existing.id, retriedAttemptId: attempt.id, created: false };

      // Spec 158: a FAILED attempt is retryable by hand only once automatic
      // drafting has stopped for this request (the failure cap); below the
      // cap the dispatcher still retries it on its own.
      const [failures] = await tx`
        select count(*)::int as n from profile_correction_drafts
        where correction_request_id = ${row.id} and status = ${PROFILE_DRAFT_STATUS.failed}
      `;
      const capped = Number(failures?.n ?? 0) >= PROFILE_DRAFT_MAX_AUTO_ATTEMPTS;
      const retryable: readonly string[] = capped
        ? [...RETRYABLE_ATTEMPT_STATUSES, PROFILE_DRAFT_STATUS.failed]
        : RETRYABLE_ATTEMPT_STATUSES;
      if (!retryable.includes(attempt.status)) {
        throw new ClassifiedError(
          "conflict",
          attempt.status === PROFILE_DRAFT_STATUS.failed
            ? `Draft attempt ${attempt.id} failed, but automatic drafting retries it until ${PROFILE_DRAFT_MAX_AUTO_ATTEMPTS} attempts have failed.`
            : `Draft attempt ${attempt.id} is ${attempt.status}; only an attempt with an unknown outcome, an orphaned draft, or a request that reached the failure cap needs a manual retry.`
        );
      }
      if (row.status !== PROFILE_CORRECTION_STATUS.readyToDraft) {
        throw new ClassifiedError("conflict", `The correction request is ${row.status}, not ready to draft.`);
      }
      if (row.requestSha256 !== input.expectedRequestSha256) {
        throw new ClassifiedError("conflict", "The request hash changed; review the current request before retrying.");
      }
      const active = await activeDestination(tx, input.projectId, row.profileUrl, { lock: true });
      if (!active || active.id !== input.expectedDestinationId || row.destinationId !== active.id) {
        throw new ClassifiedError(
          "conflict",
          "The destination changed or is no longer active; record or re-route the destination before retrying."
        );
      }
      const notApproved = await contentApprovalError(tx, row);
      if (notApproved) throw new ClassifiedError("conflict", `The request can no longer be drafted: ${notApproved}.`);

      const superseded = await setDraftStatus(tx, attempt.id, {
        from: retryable,
        to: PROFILE_DRAFT_STATUS.superseded,
        reason: `operator confirmed no usable Gmail draft exists: ${input.reason}`,
      });
      if (!superseded) throw new ClassifiedError("conflict", "The draft attempt changed state; reload and try again.");

      const draftAttemptId = randomUUID();
      const inserted = await insertRetryAttempt(tx, {
        id: draftAttemptId,
        projectId: input.projectId,
        correctionRequestId: row.id,
        destinationId: active.id,
        requestSha256: row.requestSha256,
        runIdempotencyKey: profileDraftRunKey(draftAttemptId),
        retryOf: attempt.id,
        requestedBy: user.id,
        reason: input.reason,
      });
      if (!inserted) {
        throw new ClassifiedError("conflict", "Another drafting attempt is already active for this request.");
      }
      const { event } = await publishEvent(tx, {
        type: PROFILE_CORRECTION_READY_EVENT,
        projectId: input.projectId,
        actorId: user.id,
        payload: { correctionRequestId: row.id, destinationId: active.id, draftAttemptId },
        dedupeKey: profileDraftIdempotencyKey(draftAttemptId),
      });
      await setDraftEvent(tx, draftAttemptId, event.id);
      await writeAudit(tx, {
        userId: user.id,
        action: "profile_correction.draft_retried",
        entity: "profile_correction_request",
        entityId: row.id,
        projectId: input.projectId,
        detail: {
          from: attempt.status,
          supersededAttemptId: attempt.id,
          supersededGmailDraftId: attempt.gmailDraftId,
          newAttemptId: draftAttemptId,
          destinationId: active.id,
          requestSha256: row.requestSha256,
          reason: input.reason,
        },
      });
      return { draftAttemptId, retriedAttemptId: attempt.id, created: true };
    });
    return ok(result);
  } catch (err) {
    return fail(err);
  }
}
