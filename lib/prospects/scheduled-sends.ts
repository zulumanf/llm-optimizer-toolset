/**
 * Scheduled-send dispatch (spec 091). The worker's tick drains approved
 * drafts whose human-named `scheduled_send_at` has arrived, transmitting
 * each through sendProspectDraft — the same single gated entry point a
 * human click uses. Nothing here originates, edits, or reschedules a send
 * (PRINCIPLES #8): it executes exactly the action a human confirmed, and
 * the full gate re-runs at transmission time.
 *
 * Claim discipline: each attempt first commits a claim marker
 * (`send_claimed_at` + incremented `send_attempts`), THEN dispatches. A
 * claim that never recorded an outcome means the process died between
 * Gmail possibly accepting the message and the commit — that draft is
 * parked, never auto-retried, because a retry could double-send. A clean
 * failure (an error we caught and recorded) is retried up to
 * SCHEDULED_SEND_MAX_ATTEMPTS, then parked with its reason.
 */
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import type { CurrentUser } from "@/lib/auth";
import { log } from "@/lib/logger";
import { sendProspectDraft } from "@/lib/prospects/service";
import { logActivity } from "@/lib/prospects/shared";
import {
  SCHEDULED_SEND_MAX_ATTEMPTS,
  SCHEDULED_SEND_STALE_CLAIM_MINUTES,
} from "@/lib/prospects/constants";
import type { ErrorKind } from "@/lib/errors";
import { createHash } from "node:crypto";
import { executeCapability } from "@/lib/connectors/execute";
import type { ParsedGmailMessage } from "@/lib/connectors/adapters/google";

/** Gate refusals and structural problems don't self-heal; retrying them
 * only burns attempts. Everything else is treated as transport trouble. */
const TERMINAL_KINDS: ReadonlySet<ErrorKind> = new Set([
  "validation",
  "forbidden",
  "not_found",
  "conflict",
]);

export interface ScheduledSendReport {
  due: number;
  sent: number;
  retryable: number;
  parked: number;
  /** Spec 137: stale claims resolved by mailbox fingerprint, not resent. */
  reconciled: number;
}

interface ClaimedDraft {
  id: string;
  prospectId: string;
  scheduledBy: string | null;
  businessPurpose: string | null;
  attempts: number;
  /** Spec 137 send intent: the Message-ID stamped on the outgoing mail. */
  sendMessageId: string | null;
}

export const RECONCILED_GATE_VERSION = "reconciled-by-fingerprint-v1";

/**
 * Spec 137 reconciliation. A stale claim means the previous worker died
 * between Gmail possibly accepting the message and the ledger commit. When
 * the draft carries a send intent we search the mailbox for its exact
 * RFC 5322 Message-ID: found → the message left; record the ledger row
 * from the mailbox (effectively-once, no resend); not found or search
 * failed → park for a human, never a blind resend.
 */
export async function reconcileStaleClaim(draft: ClaimedDraft): Promise<"reconciled" | "not_found" | "search_failed" | "no_fingerprint"> {
  if (!draft.sendMessageId) return "no_fingerprint";
  const bare = draft.sendMessageId.replace(/^<|>$/g, "");
  const res = await executeCapability<{ messages: ParsedGmailMessage[] }>({
    capability: "email.search_messages", projectId: null, provider: "gmail", mode: "live",
    input: { q: `rfc822msgid:${bare}`, maxResults: 5 },
  });
  if (!res.ok) return "search_failed";
  const found = (res.data?.messages ?? []).find((m) => (m.messageId ?? "").replace(/^<|>$/g, "") === bare) ?? res.data?.messages?.[0];
  if (!found) return "not_found";
  await sql.begin(async (tx) => {
    const [d] = await tx`select d.subject, d.body, d.prospect_id, coalesce(c.email, p.email) as email
      from outreach_drafts d left join prospect_contacts c on c.id = d.contact_id join prospects p on p.id = d.prospect_id where d.id = ${draft.id}`;
    const bodyHash = createHash("sha256").update(`${(d?.subject as string) ?? ""}\n${(d?.body as string) ?? ""}`).digest("hex");
    const [row] = await tx`
      insert into prospect_outreach_sends
        (draft_id, prospect_id, channel, recipient_email, body_hash, business_purpose, gate_verdict, allowed,
         provider_message_id, sent_by, gmail_thread_id, sent_at, reconciled_from)
      values (${draft.id}, ${draft.prospectId}, 'gmail', ${(d?.email as string | null) ?? null}, ${bodyHash},
        ${draft.businessPurpose ?? "reconciled after lost acknowledgement"},
        ${tx.json({ version: RECONCILED_GATE_VERSION, checks: [{ name: "mailbox_fingerprint", passed: true, detail: `rfc822msgid ${bare} found in the mailbox` }] } as never)},
        true, ${found.id}, ${draft.scheduledBy}, ${found.threadId ?? null}, ${found.date ? new Date(found.date) : new Date()}, 'gmail rfc822msgid search')
      returning id`;
    await tx`update outreach_drafts set sent_recorded_at = now(), sent_recorded_by = ${draft.scheduledBy}, send_claimed_at = null, scheduled_send_at = null where id = ${draft.id}`;
    await writeAudit(tx, { userId: draft.scheduledBy, action: "prospect.send_reconciled", entity: "prospect_outreach_send", entityId: row!.id as string, detail: { draftId: draft.id, messageId: bare, providerMessageId: found.id } });
    await logActivity(tx, draft.prospectId, "send_reconciled", { draftId: draft.id, providerMessageId: found.id }, draft.scheduledBy);
  });
  log("warn", "outreach.scheduled_send_reconciled", { draftId: draft.id, providerMessageId: found.id });
  return "reconciled";
}

/** Park a draft: clear its schedule, record why, audit it. The draft stays
 * approved — a human can re-schedule after acting on the reason. */
async function park(draft: ClaimedDraft, reason: string): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`
      update outreach_drafts set
        scheduled_send_at = null, send_claimed_at = null,
        last_send_error = ${reason.slice(0, 500)}
      where id = ${draft.id}
    `;
    await writeAudit(tx, {
      userId: draft.scheduledBy,
      action: "prospect.scheduled_send_parked",
      entity: "outreach_draft",
      entityId: draft.id,
      detail: { reason, attempts: draft.attempts, worker: true },
    });
    await logActivity(
      tx,
      draft.prospectId,
      "scheduled_send_parked",
      { draftId: draft.id, reason },
      draft.scheduledBy
    );
  });
}

export interface OutboxRow {
  draftId: string;
  prospectId: string;
  businessName: string;
  subject: string | null;
  scheduledSendAt: string | null;
  scheduledByName: string | null;
  attempts: number;
  lastSendError: string | null;
  /** A claim marker with no recorded outcome — a worker may be
   * transmitting right now, or died mid-dispatch. Never auto-retried. */
  inFlight: boolean;
}

/** The scheduled-send outbox, read-only (spec 102): what is queued to
 * transmit (soonest first) and what parked with its reason. */
export async function listScheduledOutbox(
  limit = 20
): Promise<{ scheduled: OutboxRow[]; parked: OutboxRow[]; omitted: number }> {
  const capped = Math.min(Math.max(limit, 1), 50);
  const rows = await sql`
    select d.id as draft_id, d.prospect_id, p.business_name, d.subject,
      d.scheduled_send_at, d.send_attempts, d.send_claimed_at,
      d.last_send_error, u.name as scheduled_by_name,
      count(*) over ()::int as total
    from outreach_drafts d
    join prospects p on p.id = d.prospect_id
    left join users u on u.id = d.scheduled_by
    where d.status = 'approved' and d.sent_recorded_at is null
      and (d.scheduled_send_at is not null or d.last_send_error is not null)
      and p.archived_at is null
    order by d.scheduled_send_at asc nulls last
    limit ${capped}
  `;
  const toOutbox = (r: Record<string, unknown>): OutboxRow => ({
    draftId: r.draftId as string,
    prospectId: r.prospectId as string,
    businessName: r.businessName as string,
    subject: (r.subject as string | null) ?? null,
    scheduledSendAt: r.scheduledSendAt ? new Date(r.scheduledSendAt as string).toISOString() : null,
    scheduledByName: (r.scheduledByName as string | null) ?? null,
    attempts: Number(r.sendAttempts ?? 0),
    lastSendError: (r.lastSendError as string | null) ?? null,
    inFlight: r.sendClaimedAt != null,
  });
  const all = rows.map(toOutbox);
  return {
    scheduled: all.filter((r) => r.scheduledSendAt !== null),
    parked: all.filter((r) => r.scheduledSendAt === null),
    omitted: Math.max(0, Number(rows[0]?.total ?? 0) - rows.length),
  };
}

export async function drainScheduledSends(limit = 5): Promise<ScheduledSendReport> {
  const report: ScheduledSendReport = { due: 0, sent: 0, retryable: 0, parked: 0, reconciled: 0 };

  // Phase 1 — claim, in its own committed transaction, so the in-flight
  // marker survives a crash during dispatch. Stale claims are parked here
  // rather than retried: the previous attempt may have transmitted.
  const stale: ClaimedDraft[] = [];
  const claimed: ClaimedDraft[] = [];
  await sql.begin(async (tx) => {
    const due = await tx`
      select id, prospect_id, scheduled_by, scheduled_business_purpose,
        send_attempts, send_claimed_at, send_message_id
      from outreach_drafts
      where status = 'approved' and sent_recorded_at is null
        and scheduled_send_at is not null and scheduled_send_at <= now()
      -- Send priority when the daily cap is tight: human replies to active
      -- prospects (reply_to_id) → due Touch 2/3 (sequence_id) → new cold
      -- Touch 1. Warm conversations are never crowded out by cold sends.
      order by (reply_to_id is not null) desc, (sequence_id is not null) desc, scheduled_send_at asc
      limit ${limit}
      for update skip locked
    `;
    report.due = due.length;
    for (const row of due) {
      const draft: ClaimedDraft = {
        id: row.id as string,
        prospectId: row.prospectId as string,
        scheduledBy: (row.scheduledBy as string | null) ?? null,
        businessPurpose: (row.scheduledBusinessPurpose as string | null) ?? null,
        attempts: Number(row.sendAttempts ?? 0),
        sendMessageId: (row.sendMessageId as string | null) ?? null,
      };
      const claimedAt = row.sendClaimedAt as Date | null;
      if (claimedAt) {
        // An outstanding claim means a prior attempt never recorded its
        // outcome. Young claims may belong to a worker mid-dispatch right
        // now — leave those alone; old ones are a crash, and ambiguous.
        const ageMinutes = (Date.now() - claimedAt.getTime()) / 60_000;
        if (ageMinutes >= SCHEDULED_SEND_STALE_CLAIM_MINUTES) stale.push(draft);
        continue;
      }
      if (draft.attempts >= SCHEDULED_SEND_MAX_ATTEMPTS) {
        // Defensive: parked drafts have no schedule, so this should not
        // occur; if it does, park rather than loop forever.
        stale.push(draft);
        continue;
      }
      claimed.push(draft);
      await tx`
        update outreach_drafts set
          send_claimed_at = now(), send_attempts = ${draft.attempts + 1},
          last_send_error = null
        where id = ${draft.id}
      `;
    }
  });

  for (const draft of stale) {
    const outcome = await reconcileStaleClaim(draft);
    if (outcome === "reconciled") { report.reconciled += 1; continue; }
    await park(
      draft,
      outcome === "not_found"
        ? "A previous send attempt did not record an outcome; the mailbox holds no message with this send's fingerprint (rfc822msgid). Nothing left — safe to reschedule."
        : "A previous send attempt did not record an outcome (worker died mid-dispatch). " +
          "The message may or may not have left — verify in the Gmail Sent folder before rescheduling."
    );
    report.parked += 1;
  }

  // Phase 2 — dispatch each claim through the one gated entry point, then
  // record the outcome (clearing the claim marker) in a fresh transaction.
  for (const draft of claimed) {
    const attempts = draft.attempts + 1;
    const [schedulerRow] = draft.scheduledBy
      ? await sql`
          select id, email, name, role from users
          where id = ${draft.scheduledBy} and active
        `
      : [];
    if (!schedulerRow) {
      await park(
        { ...draft, attempts },
        "The scheduling user is no longer active — the confirmation behind this send no longer stands."
      );
      report.parked += 1;
      continue;
    }
    const scheduler: CurrentUser = {
      id: schedulerRow.id as string,
      email: schedulerRow.email as string,
      name: schedulerRow.name as string,
      role: schedulerRow.role as CurrentUser["role"],
    };

    const result = await sendProspectDraft(scheduler, {
      draftId: draft.id,
      channel: "gmail",
      businessPurpose: draft.businessPurpose ?? "",
      unattended: true,
    });

    if (result.ok) {
      await sql`update outreach_drafts set send_claimed_at = null where id = ${draft.id}`;
      log("info", "outreach.scheduled_send_sent", {
        draftId: draft.id,
        providerMessageId: result.data.providerMessageId,
      });
      report.sent += 1;
      continue;
    }

    const terminal =
      TERMINAL_KINDS.has(result.error.kind) || attempts >= SCHEDULED_SEND_MAX_ATTEMPTS;
    if (terminal) {
      await park({ ...draft, attempts }, result.error.message);
      report.parked += 1;
    } else {
      // Clean transport failure: nothing left the building. Clear the
      // claim, keep the schedule — the next tick retries.
      await sql`
        update outreach_drafts set
          send_claimed_at = null, last_send_error = ${result.error.message.slice(0, 500)}
        where id = ${draft.id}
      `;
      report.retryable += 1;
    }
    log(terminal ? "warn" : "info", "outreach.scheduled_send_failed", {
      draftId: draft.id,
      attempts,
      terminal,
      kind: result.error.kind,
      error: result.error.message,
    });
  }

  return report;
}
