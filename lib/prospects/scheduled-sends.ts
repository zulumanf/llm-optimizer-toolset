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
}

interface ClaimedDraft {
  id: string;
  prospectId: string;
  scheduledBy: string | null;
  businessPurpose: string | null;
  attempts: number;
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

export async function drainScheduledSends(limit = 5): Promise<ScheduledSendReport> {
  const report: ScheduledSendReport = { due: 0, sent: 0, retryable: 0, parked: 0 };

  // Phase 1 — claim, in its own committed transaction, so the in-flight
  // marker survives a crash during dispatch. Stale claims are parked here
  // rather than retried: the previous attempt may have transmitted.
  const stale: ClaimedDraft[] = [];
  const claimed: ClaimedDraft[] = [];
  await sql.begin(async (tx) => {
    const due = await tx`
      select id, prospect_id, scheduled_by, scheduled_business_purpose,
        send_attempts, send_claimed_at
      from outreach_drafts
      where status = 'approved' and sent_recorded_at is null
        and scheduled_send_at is not null and scheduled_send_at <= now()
      order by scheduled_send_at asc
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
    await park(
      draft,
      "A previous send attempt did not record an outcome (worker died mid-dispatch). " +
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
