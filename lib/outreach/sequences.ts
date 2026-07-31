/**
 * Outreach sequences.
 *
 * The design rule: every stop condition is a **recorded terminal state**, never
 * the absence of a next step. A sequence that stopped because someone replied
 * looks different in the database from one that stopped because the dispatcher
 * died, and that difference is what makes the stop rules trustworthy.
 *
 * A stopped sequence cannot be resumed. Continuing after a reply or an opt-out
 * requires creating a new sequence, which forces a fresh human decision.
 */
import { createHash } from "node:crypto";
import { sql, type TransactionSql } from "@/db/client";
import { ClassifiedError } from "@/lib/errors";
import { normalizeEmail } from "@/lib/connectors/mapping";
import { checkSuppression, suppress } from "@/lib/outreach/suppression";
import { publishEvent } from "@/lib/events/bus";
import { log } from "@/lib/logger";

/**
 * Sequence mutations are transactional by nature: a stop, its cancelled drafts,
 * its suppression entry and its audit row must commit together or not at all.
 */
type Tx = TransactionSql;

export const SEQUENCE_STOP_REASONS = [
  "replied",
  "opted_out",
  "bounced",
  "booked",
  "manual",
  "suppressed",
] as const;
export type SequenceStopReason = (typeof SEQUENCE_STOP_REASONS)[number];

export type SequenceStatus =
  | "active"
  | "stopped_replied"
  | "stopped_opted_out"
  | "stopped_bounced"
  | "stopped_booked"
  | "stopped_manual"
  | "stopped_suppressed"
  | "completed";

const STOP_STATUS: Record<SequenceStopReason, SequenceStatus> = {
  replied: "stopped_replied",
  opted_out: "stopped_opted_out",
  bounced: "stopped_bounced",
  booked: "stopped_booked",
  manual: "stopped_manual",
  suppressed: "stopped_suppressed",
};

export interface OutreachSequence {
  id: string;
  projectId: string | null;
  workflowRunId: string | null;
  subjectKind: "prospect" | "client" | "journalist" | "partner";
  subjectRef: string;
  recipientEmail: string;
  recipientName: string;
  status: SequenceStatus;
  stopReason: string | null;
  currentStep: number;
  maxSteps: number;
  nextSendAt: Date | null;
}

export interface OutreachMessage {
  id: string;
  sequenceId: string;
  step: number;
  subject: string;
  body: string;
  bodyHash: string;
  approvalId: string | null;
  status: "draft" | "approved" | "sent" | "failed" | "suppressed" | "cancelled";
  claims: OutreachClaim[];
  evidenceIds: string[];
  providerMessageId: string | null;
  sentAt: Date | null;
}

/**
 * A factual statement in an outreach message, with the evidence it rests on.
 * `evidenceIds` empty is a blocking condition, not a warning — see
 * `verifyClaimsSupported`.
 */
export interface OutreachClaim {
  statement: string;
  kind: "fact" | "calculation" | "observation" | "question" | "opinion";
  evidenceIds: string[];
  sourceUrl?: string;
}

/** The artifact hash an approval is bound to. */
export function hashBody(subject: string, body: string): string {
  return createHash("sha256").update(`${subject}\n\n${body}`).digest("hex");
}

function toSequence(row: Record<string, unknown>): OutreachSequence {
  return {
    id: row.id as string,
    projectId: (row.projectId as string | null) ?? null,
    workflowRunId: (row.workflowRunId as string | null) ?? null,
    subjectKind: row.subjectKind as OutreachSequence["subjectKind"],
    subjectRef: row.subjectRef as string,
    recipientEmail: row.recipientEmail as string,
    recipientName: (row.recipientName as string) ?? "",
    status: row.status as SequenceStatus,
    stopReason: (row.stopReason as string | null) ?? null,
    currentStep: Number(row.currentStep ?? 0),
    maxSteps: Number(row.maxSteps ?? 4),
    nextSendAt: (row.nextSendAt as Date | null) ?? null,
  };
}

/**
 * Start a sequence. Refuses a suppressed recipient outright — creating a
 * sequence we already know we may not send is a trap for a later change.
 */
export async function createSequence(
  tx: Tx,
  args: {
    projectId: string | null;
    workflowRunId: string | null;
    subjectKind: OutreachSequence["subjectKind"];
    subjectRef: string;
    recipientEmail: string;
    recipientName?: string;
    maxSteps?: number;
  }
): Promise<{ sequenceId: string; refused: boolean; reason: string }> {
  const email = normalizeEmail(args.recipientEmail);
  const suppression = await checkSuppression({ email, projectId: args.projectId });
  if (suppression.suppressed) {
    return {
      sequenceId: "",
      refused: true,
      reason: `recipient is suppressed (${suppression.reason})`,
    };
  }

  const [row] = await tx`
    insert into outreach_sequences (
      project_id, workflow_run_id, subject_kind, subject_ref,
      recipient_email, recipient_name, max_steps
    ) values (
      ${args.projectId}, ${args.workflowRunId}, ${args.subjectKind}, ${args.subjectRef},
      ${email}, ${args.recipientName ?? ""}, ${args.maxSteps ?? 4}
    )
    returning id
  `;
  return { sequenceId: row!.id as string, refused: false, reason: "" };
}

export async function getSequence(sequenceId: string): Promise<OutreachSequence | null> {
  const [row] = await sql`select * from outreach_sequences where id = ${sequenceId}`;
  return row ? toSequence(row) : null;
}

export async function sequenceForSubject(
  projectId: string | null,
  subjectRef: string
): Promise<OutreachSequence | null> {
  const [row] = await sql`
    select * from outreach_sequences
    where subject_ref = ${subjectRef}
      and (${projectId ?? null}::uuid is null or project_id = ${projectId ?? null})
    order by created_at desc limit 1
  `;
  return row ? toSequence(row) : null;
}

/**
 * Claims must be supported. An unsupported factual statement blocks the send —
 * it is not softened into a hedge, because hedging hides that we could not
 * support the claim.
 */
export function verifyClaimsSupported(claims: OutreachClaim[]): {
  ok: boolean;
  unsupported: string[];
} {
  const unsupported = claims
    .filter(
      (claim) =>
        (claim.kind === "fact" || claim.kind === "calculation") &&
        claim.evidenceIds.length === 0 &&
        (claim.sourceUrl ?? "").length === 0
    )
    .map((claim) => claim.statement);
  return { ok: unsupported.length === 0, unsupported };
}

export async function addMessage(
  tx: Tx,
  args: {
    sequenceId: string;
    step: number;
    subject: string;
    body: string;
    claims: OutreachClaim[];
    evidenceIds: string[];
    approvalId?: string | null;
  }
): Promise<{ messageId: string; bodyHash: string }> {
  const verdict = verifyClaimsSupported(args.claims);
  if (!verdict.ok) {
    throw new ClassifiedError(
      "validation",
      `Outreach message has unsupported factual claims and cannot be drafted: ${verdict.unsupported.join(" | ")}`
    );
  }
  const bodyHash = hashBody(args.subject, args.body);
  const [row] = await tx`
    insert into outreach_messages (
      sequence_id, step, subject, body, body_hash, claims, evidence_ids, approval_id
    ) values (
      ${args.sequenceId}, ${args.step}, ${args.subject}, ${args.body}, ${bodyHash},
      ${tx.json(args.claims as never)}, ${args.evidenceIds}, ${args.approvalId ?? null}
    )
    on conflict (sequence_id, step) do update set
      subject = excluded.subject,
      body = excluded.body,
      body_hash = excluded.body_hash,
      claims = excluded.claims,
      evidence_ids = excluded.evidence_ids,
      approval_id = excluded.approval_id
    where outreach_messages.status = 'draft'
    returning id
  `;
  if (!row) {
    throw new ClassifiedError(
      "conflict",
      `Step ${args.step} of this sequence is no longer a draft and cannot be rewritten.`
    );
  }
  return { messageId: row.id as string, bodyHash };
}

export async function markMessageSent(
  tx: Tx,
  args: {
    messageId: string;
    providerMessageId: string | null;
    nextSendAt: Date | null;
  }
): Promise<void> {
  const [row] = await tx`
    update outreach_messages set
      status = 'sent', sent_at = now(), provider_message_id = ${args.providerMessageId}
    where id = ${args.messageId} and status in ('draft', 'approved')
    returning sequence_id, step
  `;
  if (!row) {
    throw new ClassifiedError(
      "conflict",
      "This message was already sent or cancelled; refusing to record a second send."
    );
  }
  await tx`
    update outreach_sequences set
      current_step = ${Number(row.step)},
      next_send_at = ${args.nextSendAt},
      status = case
        when ${Number(row.step)} >= max_steps then 'completed'
        else status end,
      updated_at = now()
    where id = ${row.sequenceId as string}
  `;
}

export async function markMessageFailed(
  tx: Tx,
  args: { messageId: string; error: string; suppressed?: boolean }
): Promise<void> {
  await tx`
    update outreach_messages set
      status = ${args.suppressed ? "suppressed" : "failed"},
      error = ${args.error.slice(0, 500)}
    where id = ${args.messageId}
  `;
}

/**
 * Stop a sequence permanently. Idempotent: stopping an already-stopped sequence
 * is a no-op rather than an error, because a reply and a bounce can arrive
 * together and neither should fail.
 */
export async function stopSequence(
  tx: Tx,
  args: {
    sequenceId: string;
    reason: SequenceStopReason;
    detail?: string;
    /** An opt-out or bounce also suppresses the address globally. */
    userId?: string | null;
  }
): Promise<{ stopped: boolean; alreadyStopped: boolean }> {
  const [sequence] = await tx`
    select id, status, recipient_email, project_id from outreach_sequences
    where id = ${args.sequenceId}
  `;
  if (!sequence) {
    throw new ClassifiedError("not_found", `Outreach sequence ${args.sequenceId} not found.`);
  }
  if ((sequence.status as string) !== "active") {
    return { stopped: false, alreadyStopped: true };
  }

  await tx`
    update outreach_sequences set
      status = ${STOP_STATUS[args.reason]},
      stop_reason = ${args.detail ?? args.reason},
      stopped_at = now(),
      next_send_at = null,
      updated_at = now()
    where id = ${args.sequenceId}
  `;
  // Any queued draft is cancelled — a stopped sequence must not leave a
  // sendable artifact lying around.
  await tx`
    update outreach_messages set status = 'cancelled'
    where sequence_id = ${args.sequenceId} and status in ('draft', 'approved')
  `;

  // An opt-out or a hard bounce is a permanent instruction, not a per-sequence
  // one. Suppress globally so no future sequence can contact them.
  if (args.reason === "opted_out" || args.reason === "bounced") {
    await suppress(tx, {
      scope: "email",
      value: sequence.recipientEmail as string,
      reason: args.reason === "opted_out" ? "opt_out" : "hard_bounce",
      detail: args.detail ?? `sequence ${args.sequenceId}`,
      projectId: null,
      userId: args.userId ?? null,
    });
  }

  log("info", "outreach.sequence_stopped", {
    sequenceId: args.sequenceId,
    reason: args.reason,
  });
  return { stopped: true, alreadyStopped: false };
}

/**
 * Apply an inbound signal to a sequence. This is the single place the four
 * stop conditions in the spec are interpreted, so a new inbound channel cannot
 * invent its own semantics.
 */
export async function applyInboundSignal(
  tx: Tx,
  args: {
    sequenceId: string;
    signal: "reply" | "opt_out" | "bounce" | "meeting_booked";
    detail?: string;
    projectId?: string | null;
  }
): Promise<{ stopped: boolean }> {
  const reason: SequenceStopReason =
    args.signal === "reply"
      ? "replied"
      : args.signal === "opt_out"
        ? "opted_out"
        : args.signal === "bounce"
          ? "bounced"
          : "booked";
  const result = await stopSequence(tx, {
    sequenceId: args.sequenceId,
    reason,
    detail: args.detail,
  });
  return { stopped: result.stopped };
}

export async function dueSequences(limit = 50): Promise<OutreachSequence[]> {
  const rows = await sql`
    select * from outreach_sequences
    where status = 'active' and next_send_at is not null and next_send_at <= now()
    order by next_send_at asc limit ${limit}
  `;
  return rows.map(toSequence);
}

export async function messagesFor(sequenceId: string): Promise<OutreachMessage[]> {
  const rows = await sql`
    select * from outreach_messages where sequence_id = ${sequenceId} order by step asc
  `;
  return rows.map((row) => ({
    id: row.id as string,
    sequenceId: row.sequenceId as string,
    step: Number(row.step),
    subject: row.subject as string,
    body: row.body as string,
    bodyHash: row.bodyHash as string,
    approvalId: (row.approvalId as string | null) ?? null,
    status: row.status as OutreachMessage["status"],
    claims: (row.claims as OutreachClaim[]) ?? [],
    evidenceIds: (row.evidenceIds as string[]) ?? [],
    providerMessageId: (row.providerMessageId as string | null) ?? null,
    sentAt: (row.sentAt as Date | null) ?? null,
  }));
}

/** Publish the domain event a stop implies, so downstream work can react. */
export async function publishSequenceStopped(
  tx: Tx,
  args: { sequence: OutreachSequence; reason: SequenceStopReason }
): Promise<void> {
  if (args.reason !== "booked" && args.reason !== "replied") return;
  if (!args.sequence.projectId) return;
  await publishEvent(tx, {
    type: "opportunity.created",
    projectId: args.sequence.projectId,
    source: "workflow",
    payload: {
      opportunityId: args.sequence.subjectRef,
      stage: args.reason === "booked" ? "meeting_booked" : "replied",
    },
    dedupeKey: `outreach:${args.sequence.id}:${args.reason}`,
  });
}
