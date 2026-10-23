/**
 * Spec 147 §7.2–§7.3 — routing an approved correction to its destination.
 *
 * One implementation serves both the run's `route_correction` node and late
 * resolution (an operator setting, replacing or archiving a destination):
 *
 *   no active destination  → destination_required   (nothing published)
 *   client_editor          → ready_to_draft
 *   publisher              → awaiting_external_approval, and one
 *                            `profile.external_approval_required` event per
 *                            (request, destination) — the authorization
 *                            workflow's human gate must pass before drafting.
 *
 * Every move re-proves the request's integrity, its content approval and its
 * hash binding, takes the destination as it is under lock, and is guarded on
 * the row's current status. A destination is never inferred: no row means no
 * destination. Nothing external happens here.
 */
import { z } from "zod";
import type { TransactionSql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import {
  activeDestination,
  approvalById,
  enqueueDraftDispatchJob,
  setCorrectionRoute,
  supersedePendingDrafts,
  type CorrectionRow,
  type DestinationRow,
} from "@/db/profile-corrections";
import { publishEvent } from "@/lib/events/bus";
import { approvalBindingError } from "@/lib/profile-corrections/approval-binding";
import {
  DESTINATION_KINDS,
  PROFILE_CORRECTION_STATUS,
  PROFILE_EXTERNAL_APPROVAL_EVENT,
  profileExternalApprovalKey,
  type DestinationKind,
} from "@/lib/profile-corrections/constants";
import { profileCorrectionRequestHash } from "@/lib/profile-corrections/request";

const APPROVED_DECISION = "approved";

/** What a destination must be to receive anything. Checked again at routing. */
export const routableDestinationSchema = z
  .object({
    id: z.string().uuid(),
    kind: z.enum(DESTINATION_KINDS),
    recipientName: z.string().trim().min(1),
    email: z.string().trim().email(),
    basis: z.string().trim().min(1),
    sourceUrl: z.string().url().regex(/^https?:\/\//i).nullable(),
    archivedAt: z.null(),
  })
  .refine((d) => d.kind !== "publisher" || d.sourceUrl !== null, {
    message: "a publisher destination needs the URL its corrections address was found at",
    path: ["sourceUrl"],
  });

export type RoutedStatus =
  | typeof PROFILE_CORRECTION_STATUS.destinationRequired
  | typeof PROFILE_CORRECTION_STATUS.awaitingExternalApproval
  | typeof PROFILE_CORRECTION_STATUS.readyToDraft;

/** Pure: where a request goes for a given (validated) destination. */
export function routingTarget(
  destination: { id: string; kind: DestinationKind } | null
): { status: RoutedStatus; destinationId: string | null; publishExternalApproval: boolean } {
  if (!destination) {
    return { status: PROFILE_CORRECTION_STATUS.destinationRequired, destinationId: null, publishExternalApproval: false };
  }
  if (destination.kind === "publisher") {
    return {
      status: PROFILE_CORRECTION_STATUS.awaitingExternalApproval,
      destinationId: destination.id,
      publishExternalApproval: true,
    };
  }
  return { status: PROFILE_CORRECTION_STATUS.readyToDraft, destinationId: destination.id, publishExternalApproval: false };
}

export type RouteResult =
  | {
      ok: true;
      correctionRequestId: string;
      from: string;
      status: RoutedStatus;
      destinationId: string | null;
      destinationKind: DestinationKind | null;
      changed: boolean;
      eventId: string | null;
    }
  | { ok: false; correctionRequestId: string; error: string };

/** Content integrity + a hash-bound human approval. */
export async function contentApprovalError(tx: TransactionSql, row: CorrectionRow): Promise<string | null> {
  if (profileCorrectionRequestHash(row.request) !== row.requestSha256) {
    return "the stored request no longer hashes to its recorded hash";
  }
  if (!row.approvalId) return "the request has no recorded approval";
  const approval = await approvalById(tx, row.approvalId);
  if (!approval || approval.projectId !== row.projectId || approval.workflowRunId !== row.workflowRunId) {
    return "the recorded approval does not belong to this request";
  }
  if (approval.decision !== APPROVED_DECISION) return "the recorded approval is not an approval";
  return approvalBindingError(approval.detail, row.requestSha256);
}

/**
 * Route one locked request. The caller holds the profile's destination lock
 * (`lockProfileDestination`) and the row lock, in that order.
 */
export async function routeCorrectionInTx(
  tx: TransactionSql,
  row: CorrectionRow,
  actorId: string | null
): Promise<RouteResult> {
  const fail = (error: string): RouteResult => ({ ok: false, correctionRequestId: row.id, error });

  const notApproved = await contentApprovalError(tx, row);
  if (notApproved) return fail(notApproved);

  const active: DestinationRow | null = await activeDestination(tx, row.projectId, row.profileUrl, { lock: true });
  let destination: { id: string; kind: DestinationKind } | null = null;
  if (active) {
    if (active.projectId !== row.projectId || active.profileUrl !== row.profileUrl) {
      return fail("the active destination is not this project's destination for this profile");
    }
    const valid = routableDestinationSchema.safeParse(active);
    if (!valid.success) {
      return fail(`the active destination is not routable: ${valid.error.issues.map((i) => i.message).join("; ")}`);
    }
    destination = { id: valid.data.id, kind: valid.data.kind };
  }

  const target = routingTarget(destination);
  const unchanged = target.status === row.status && target.destinationId === row.destinationId;
  if (unchanged) {
    return {
      ok: true,
      correctionRequestId: row.id,
      from: row.status,
      status: target.status,
      destinationId: target.destinationId,
      destinationKind: destination?.kind ?? null,
      changed: false,
      eventId: null,
    };
  }

  const moved = await setCorrectionRoute(tx, row.id, {
    from: row.status,
    to: target.status,
    destinationId: target.destinationId,
  });
  if (!moved) return fail("the request changed state while it was being routed");
  // A drafting attempt that has not called Gmail belongs to the old route.
  await supersedePendingDrafts(tx, row.id);
  if (target.status === PROFILE_CORRECTION_STATUS.readyToDraft) {
    await enqueueDraftDispatchJob(tx);
  }

  let eventId: string | null = null;
  if (target.publishExternalApproval && target.destinationId) {
    const { event } = await publishEvent(tx, {
      type: PROFILE_EXTERNAL_APPROVAL_EVENT,
      projectId: row.projectId,
      actorId,
      payload: { correctionRequestId: row.id, destinationId: target.destinationId },
      dedupeKey: profileExternalApprovalKey(row.id, target.destinationId),
    });
    eventId = event.id;
  }

  await writeAudit(tx, {
    userId: actorId,
    action: `profile_correction.${target.status}`,
    entity: "profile_correction_request",
    entityId: row.id,
    projectId: row.projectId,
    detail: {
      from: row.status,
      destinationId: target.destinationId,
      destinationKind: destination?.kind ?? null,
      requestSha256: row.requestSha256,
      eventId,
    },
  });

  return {
    ok: true,
    correctionRequestId: row.id,
    from: row.status,
    status: target.status,
    destinationId: target.destinationId,
    destinationKind: destination?.kind ?? null,
    changed: true,
    eventId,
  };
}
