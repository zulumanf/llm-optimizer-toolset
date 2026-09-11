/**
 * Positive-reply ownership (operating review 2026-09-07). Every genuine
 * human positive reply — Gmail-synced or hand-recorded, sequence or not —
 * gets an owner, a next action and a due date the moment it is recorded,
 * and stays on Today until a human records how it was resolved. The only
 * operator is the legal sender; the owner is the user who set that identity.
 */
import { sql, type Sql, type TransactionSql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { assertCanWrite, type CurrentUser } from "@/lib/auth";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { ClassifiedError } from "@/lib/errors";
import { addBusinessDays } from "@/lib/prospects/business-days";
import { OPERATOR_TIMEZONE } from "@/lib/prospects/intent";
import { logActivity } from "@/lib/prospects/shared";
import { operatorView, type HandoffStatus, type OperatorView } from "@/lib/prospects/fulfillment-lane";
import type { FounderSalesBlock } from "@/lib/prospects/sales-block";

export const POSITIVE_REPLY_RESOLVED_ACTIVITY = "positive_reply_resolved";
export const POSITIVE_REPLY_OWNED_ACTIVITY = "positive_reply_owned";
export const POSITIVE_REPLY_NEXT_ACTION = (name: string): string =>
  `Answer ${name}'s positive reply: send the private report (or confirm it landed), then propose one tangible first change and the offer.`;

/** The founder's user id: whoever configured the active legal sender
 * identity; falls back to the earliest active human admin. */
export async function founderUserId(tx: TransactionSql | Sql = sql): Promise<string | null> {
  const [s] = await tx`select created_by from outreach_sender_identity where active order by created_at desc limit 1`;
  if (s?.createdBy) return s.createdBy as string;
  const [u] = await tx`
    select id from users where active and role = 'admin' and email not like '%@avos.local' and email not like '%@avos.internal'
    order by created_at asc limit 1`;
  return (u?.id as string | undefined) ?? null;
}

/** Due date: the next business day in the operator's timezone (a same-day
 * reply is answered today; the date is the latest acceptable). */
export function positiveReplyDueOn(receivedAt: Date, tz: string = OPERATOR_TIMEZONE): string {
  const due = addBusinessDays(receivedAt, 1, tz);
  return due.toLocaleDateString("en-CA", { timeZone: tz });
}

/** Stamp owner / next action / due date on the prospect for a positive
 * reply. Idempotent: an existing owner is kept; an existing next action
 * that is already about this reply is kept. */
export async function assignPositiveReplyOwner(
  tx: TransactionSql,
  input: { prospectId: string; replyId: string; receivedAt: Date; actorId: string; objections?: string[] }
): Promise<{ ownerId: string | null; nextActionOn: string }> {
  const ownerId = await founderUserId(tx);
  const [p] = await tx`select business_name, owner_id, next_action from prospects where id = ${input.prospectId}`;
  const name = (p?.businessName as string | undefined) ?? "the prospect";
  const nextActionOn = positiveReplyDueOn(input.receivedAt);
  await tx`
    update prospects set
      owner_id = coalesce(owner_id, ${ownerId}),
      next_action = ${POSITIVE_REPLY_NEXT_ACTION(name)},
      next_action_on = least(coalesce(next_action_on, ${nextActionOn}::date), ${nextActionOn}::date),
      updated_at = now()
    where id = ${input.prospectId}
  `;
  await logActivity(tx, input.prospectId, POSITIVE_REPLY_OWNED_ACTIVITY, {
    replyId: input.replyId, action: "answer_positive_reply", ownerId, dueOn: nextActionOn, objections: input.objections ?? [],
  }, input.actorId);
  return { ownerId: (p?.ownerId as string | null) ?? ownerId, nextActionOn };
}

export interface PositiveReplyWaiting {
  prospectId: string;
  businessName: string;
  stage: string;
  replyId: string;
  receivedAt: Date;
  excerpt: string;
  ownerName: string | null;
  nextAction: string | null;
  nextActionOn: string | null;
  /** Latest outbound after the reply (a founder answer or report delivery). */
  answeredAt: Date | null;
  handoff: { status: string; reason: string | null; autoVerdict: string | null; autonomyClass: string | null; laneMode: string | null } | null;
  /** Spec 137: the founder's concise view when the lane stopped or held. */
  lane: OperatorView | null;
  reportPublished: boolean;
  daysWaiting: number;
  overdue: boolean;
}

/** Canonical positive replies (one per prospect+received_at, latest
 * correction wins) that no human has marked resolved. */
export async function positiveRepliesWaiting(now: Date = new Date()): Promise<PositiveReplyWaiting[]> {
  const rows = await sql`
    with canonical as (
      select distinct on (r.prospect_id, r.received_at) r.*
      from prospect_replies r order by r.prospect_id, r.received_at, r.created_at desc
    )
    select c.id as reply_id, c.prospect_id, c.received_at, c.body_text,
      p.business_name, p.stage, p.next_action, p.next_action_on::text, u.name as owner_name,
      (select max(s.sent_at) from prospect_outreach_sends s where s.prospect_id = p.id and s.allowed and s.sent_at > c.received_at) as answered_at,
      (select json_build_object('status', h.status, 'reason', h.reason, 'autoVerdict', h.auto_verdict, 'autonomyClass', h.autonomy_class, 'laneMode', h.lane_mode, 'releaseVerdict', h.release_verdict)
         from prospect_report_handoffs h where h.reply_id = c.id order by h.created_at desc limit 1) as handoff,
      exists (select 1 from prospect_audits a where a.prospect_id = p.id and a.status = 'published') as report_published,
      (select v.stage from prospect_fulfillment_artifacts v join prospect_report_handoffs h2 on h2.id = v.handoff_id
         where h2.reply_id = c.id and v.kind = 'video_walkthrough' order by v.revision desc limit 1) as video_stage
    from canonical c
    join prospects p on p.id = c.prospect_id
    left join users u on u.id = p.owner_id
    where c.classification = 'positive_interest' and p.archived_at is null
      and not exists (
        select 1 from prospect_activities x
        where x.prospect_id = p.id and x.kind = ${POSITIVE_REPLY_RESOLVED_ACTIVITY} and x.occurred_at >= c.received_at)
    order by c.received_at asc
  `;
  const today = now.toLocaleDateString("en-CA", { timeZone: OPERATOR_TIMEZONE });
  return rows.map((r) => {
    const receivedAt = new Date(r.receivedAt as Date);
    const nextActionOn = (r.nextActionOn as string | null) ?? null;
    const hv = (r.handoff as { status: string; reason: string | null; autoVerdict: string | null; autonomyClass: string | null; laneMode: string | null; releaseVerdict: { verified?: boolean; reasons?: string[] } | null } | null) ?? null;
    const excerpt = ((r.bodyText as string) ?? "").replace(/\[correction of[^\]]*\]\s*/i, "").replace(/\s+/g, " ").slice(0, 160);
    return {
      prospectId: r.prospectId as string,
      businessName: r.businessName as string,
      stage: r.stage as string,
      replyId: r.replyId as string,
      receivedAt,
      excerpt,
      ownerName: (r.ownerName as string | null) ?? null,
      nextAction: (r.nextAction as string | null) ?? null,
      nextActionOn,
      answeredAt: r.answeredAt ? new Date(r.answeredAt as Date) : null,
      handoff: hv ? { status: hv.status, reason: hv.reason, autoVerdict: hv.autoVerdict, autonomyClass: hv.autonomyClass, laneMode: hv.laneMode } : null,
      lane: hv
        ? operatorView(
            { status: hv.status as HandoffStatus, reason: hv.reason, autonomyClass: hv.autonomyClass as "autonomy_eligible" | "escalate" | null, autonomyReason: null, autoVerdict: hv.autoVerdict, laneMode: hv.laneMode, releaseVerdict: hv.releaseVerdict },
            { prospectName: r.businessName as string, replyExcerpt: excerpt, reportPublished: Boolean(r.reportPublished), videoStatus: r.videoStage ? `video ${r.videoStage as string}` : undefined }
          )
        : null,
      reportPublished: Boolean(r.reportPublished),
      daysWaiting: Math.max(0, Math.floor((now.getTime() - receivedAt.getTime()) / 86_400_000)),
      overdue: nextActionOn === null || nextActionOn < today,
    };
  });
}

/** A human records how the reply was handled; the item leaves Today. The
 * reply row itself is untouched. */
export async function resolvePositiveReply(
  user: CurrentUser,
  input: { prospectId: string; replyId: string; outcome: string; note?: string }
): Promise<ActionResult<{ resolved: true }>> {
  try {
    assertCanWrite(user);
    if (!input.outcome || input.outcome.trim().length < 3) throw new ClassifiedError("validation", "State how the reply was resolved.");
    await sql.begin(async (tx) => {
      const [r] = await tx`select id from prospect_replies where id = ${input.replyId} and prospect_id = ${input.prospectId}`;
      if (!r) throw new ClassifiedError("not_found", "Reply not found on this prospect.");
      await logActivity(tx, input.prospectId, POSITIVE_REPLY_RESOLVED_ACTIVITY, { replyId: input.replyId, outcome: input.outcome.trim(), note: input.note ?? null }, user.id);
      await writeAudit(tx, { userId: user.id, action: "prospect.positive_reply_resolved", entity: "prospect", entityId: input.prospectId, detail: { replyId: input.replyId, outcome: input.outcome.trim() } });
    });
    return ok({ resolved: true });
  } catch (err) {
    return fail(err);
  }
}

/** Backfill: stamp ownership on every waiting positive reply that has none. */
export async function ensurePositiveReplyOwnership(actorId: string, now: Date = new Date()): Promise<number> {
  let n = 0;
  for (const w of await positiveRepliesWaiting(now)) {
    if (w.ownerName && w.nextAction && w.nextActionOn) continue;
    await sql.begin(async (tx) => {
      await assignPositiveReplyOwner(tx, { prospectId: w.prospectId, replyId: w.replyId, receivedAt: w.receivedAt, actorId });
    });
    n += 1;
  }
  return n;
}

export type { FounderSalesBlock };
