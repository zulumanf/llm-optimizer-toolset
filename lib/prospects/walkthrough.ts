/**
 * Walkthrough scheduling from the private report (spec 128). The prospect
 * picks one of a few plain slots in their own timezone; the pick is stored
 * and forwarded to the operator's mailbox. No calendar integration, no
 * account, no second form — the audit token is the credential.
 */
import { z } from "zod";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { executeCapability } from "@/lib/connectors/execute";
import { log } from "@/lib/logger";
import { getActiveSenderIdentity } from "@/lib/outreach/sender-identity";
import {
  isBusinessDay,
  timezoneForState,
  wallClock,
  zonedInstant,
} from "@/lib/prospects/business-days";
import { logActivity } from "@/lib/prospects/shared";

/** Local hours offered each business day. */
export const WALKTHROUGH_SLOT_HOURS = [9, 11, 14, 16] as const;
export const WALKTHROUGH_DAYS = 5;
export const WALKTHROUGH_MINUTES = 15;
/** Do not offer slots sooner than this (the operator has to confirm). */
const MIN_LEAD_HOURS = 20;

export interface WalkthroughSlot {
  /** ISO instant — the form's value. */
  at: string;
  dayLabel: string;
  timeLabel: string;
}

const DAY_FMT = (tz: string) => new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: tz });
const TIME_FMT = (tz: string) => new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz, timeZoneName: "short" });

/** The next WALKTHROUGH_DAYS business days × WALKTHROUGH_SLOT_HOURS, in the
 * prospect's zone, all at least MIN_LEAD_HOURS ahead. Pure. */
export function walkthroughSlots(now: Date, tz: string): WalkthroughSlot[] {
  const out: WalkthroughSlot[] = [];
  const earliest = now.getTime() + MIN_LEAD_HOURS * 3_600_000;
  let t = now.getTime();
  let days = 0;
  for (let i = 0; i < 30 && days < WALKTHROUGH_DAYS; i += 1) {
    const w = wallClock(new Date(t), tz);
    if (isBusinessDay(new Date(t), tz)) {
      let offered = false;
      for (const hour of WALKTHROUGH_SLOT_HOURS) {
        const at = zonedInstant(w.year, w.month, w.day, hour, 0, tz);
        if (at.getTime() < earliest) continue;
        out.push({ at: at.toISOString(), dayLabel: DAY_FMT(tz).format(at), timeLabel: TIME_FMT(tz).format(at) });
        offered = true;
      }
      if (offered) days += 1;
    }
    t = zonedInstant(w.year, w.month, w.day, 0, 0, tz).getTime() + 86_400_000 + 60_000;
  }
  return out;
}

export function groupSlotsByDay(slots: WalkthroughSlot[]): { dayLabel: string; slots: WalkthroughSlot[] }[] {
  const groups: { dayLabel: string; slots: WalkthroughSlot[] }[] = [];
  for (const s of slots) {
    const g = groups[groups.length - 1];
    if (g && g.dayLabel === s.dayLabel) g.slots.push(s);
    else groups.push({ dayLabel: s.dayLabel, slots: [s] });
  }
  return groups;
}

export interface WalkthroughContext {
  auditId: string;
  prospectId: string;
  prospectName: string;
  marketName: string;
  timezone: string;
}

/** Resolve a published audit token to the scheduling context (no view row). */
export async function walkthroughContext(token: string): Promise<WalkthroughContext | null> {
  if (!token || token.length < 20 || token.length > 100) return null;
  const [row] = await sql`
    select a.id, a.prospect_id, p.business_name, m.name as market_name, m.state_code
    from prospect_audits a
    join prospects p on p.id = a.prospect_id
    left join market_launches l on l.id = p.launch_id
    left join markets m on m.id = l.market_id
    where a.access_token = ${token} and a.status = 'published'
      and (a.expires_at is null or a.expires_at > now())
  `;
  if (!row) return null;
  return {
    auditId: row.id as string,
    prospectId: row.prospectId as string,
    prospectName: row.businessName as string,
    marketName: (row.marketName as string | null) ?? "",
    timezone: timezoneForState((row.stateCode as string | null) ?? null),
  };
}

const requestSchema = z.object({
  token: z.string().min(20).max(100),
  slotAt: z.string().datetime(),
  contact: z.string().trim().max(200).optional(),
  note: z.string().trim().max(1000).optional(),
});

export type WalkthroughResult =
  | { ok: true; dayLabel: string; timeLabel: string }
  | { ok: false; error: string };

/** Store the pick and forward it to the operator's mailbox. The store is
 * the record; a mail failure is logged on the row, never shown as failure
 * to the prospect (the operator sees it in the workspace either way). */
export async function requestWalkthrough(
  raw: unknown,
  meta: { ip?: string | null; userAgent?: string | null } = {}
): Promise<WalkthroughResult> {
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Pick a time from the list." };
  const input = parsed.data;
  const ctx = await walkthroughContext(input.token);
  if (!ctx) return { ok: false, error: "This report link is no longer active." };
  const slot = walkthroughSlots(new Date(), ctx.timezone).find((s) => s.at === input.slotAt);
  if (!slot) return { ok: false, error: "That time is no longer available. Pick another." };

  const [existing] = await sql`
    select id from prospect_walkthrough_requests where audit_id = ${ctx.auditId} and slot_at = ${new Date(slot.at)}
  `;
  const requestId = existing
    ? (existing.id as string)
    : ((await sql`
        insert into prospect_walkthrough_requests
          (audit_id, prospect_id, slot_at, timezone, contact, note, ip, user_agent)
        values (${ctx.auditId}, ${ctx.prospectId}, ${new Date(slot.at)}, ${ctx.timezone},
          ${input.contact || null}, ${input.note || null}, ${meta.ip ?? null}, ${meta.userAgent ?? null})
        returning id
      `)[0]!.id as string);

  await sql.begin(async (tx) => {
    await logActivity(tx, ctx.prospectId, "walkthrough_requested", { requestId, slotAt: slot.at, timezone: ctx.timezone }, null);
    await writeAudit(tx, {
      userId: null,
      action: "prospect.walkthrough_requested",
      entity: "prospect_walkthrough_request",
      entityId: requestId,
      detail: { auditId: ctx.auditId, prospectId: ctx.prospectId, slotAt: slot.at, contact: input.contact ?? null },
    });
  });

  if (!existing) await notifyOperator(requestId, ctx, slot, input);
  return { ok: true, dayLabel: slot.dayLabel, timeLabel: slot.timeLabel };
}

async function notifyOperator(
  requestId: string,
  ctx: WalkthroughContext,
  slot: WalkthroughSlot,
  input: { contact?: string; note?: string }
): Promise<void> {
  const identity = await getActiveSenderIdentity();
  const to = identity?.replyToEmail;
  if (!to) {
    await sql`update prospect_walkthrough_requests set notify_error = 'no sender identity' where id = ${requestId}`;
    return;
  }
  const operatorTz = "America/New_York";
  const opTime = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: operatorTz, timeZoneName: "short" }).format(new Date(slot.at));
  const body = [
    `${ctx.prospectName} picked a time for the report walkthrough.`,
    ``,
    `When: ${slot.dayLabel}, ${slot.timeLabel} (their time)`,
    `      ${opTime} (yours)`,
    `Length: ${WALKTHROUGH_MINUTES} minutes`,
    `Market: ${ctx.marketName}`,
    input.contact ? `Reach them at: ${input.contact}` : `Reach them at: the email they replied from`,
    input.note ? `Note from them: ${input.note}` : ``,
    ``,
    `Reply to them to confirm. Nothing has been put on a calendar.`,
    `Workspace: ${process.env.APP_URL ?? ""}/prospects/${ctx.prospectId}`,
  ].filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
  const res = await executeCapability<{ messageId: string }>({
    capability: "email.send_approved_message",
    projectId: null,
    provider: "gmail",
    mode: "live",
    input: { to, subject: `Walkthrough requested: ${ctx.prospectName} — ${slot.dayLabel}, ${slot.timeLabel}`, body },
  });
  if (res.ok) {
    await sql`update prospect_walkthrough_requests set notified_at = now() where id = ${requestId}`;
  } else {
    log("warn", "walkthrough.notify_failed", { requestId, error: res.error ?? res.errorCode });
    await sql`update prospect_walkthrough_requests set notify_error = ${(res.error ?? res.errorCode ?? "unknown").slice(0, 500)} where id = ${requestId}`;
  }
}

export async function listWalkthroughRequests(prospectId: string): Promise<{ id: string; slotAt: Date; timezone: string; contact: string | null; note: string | null; notifiedAt: Date | null; notifyError: string | null; createdAt: Date }[]> {
  const rows = await sql`
    select id, slot_at, timezone, contact, note, notified_at, notify_error, created_at
    from prospect_walkthrough_requests where prospect_id = ${prospectId} order by created_at desc
  `;
  return rows.map((r) => ({
    id: r.id as string, slotAt: new Date(r.slotAt as Date), timezone: r.timezone as string,
    contact: (r.contact as string | null) ?? null, note: (r.note as string | null) ?? null,
    notifiedAt: r.notifiedAt ? new Date(r.notifiedAt as Date) : null, notifyError: (r.notifyError as string | null) ?? null,
    createdAt: new Date(r.createdAt as Date),
  }));
}
