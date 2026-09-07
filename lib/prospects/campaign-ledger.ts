/**
 * Campaign digests (2026-09-06): the deterministic morning pre-flight and
 * evening ledger the outbound week is run against, computed from the send
 * ledger, the sequence table, the reply table and the handoff table. Read
 * only — nothing here can schedule, render or send. Counts are distinct by
 * definition: total outbound (every allowed Gmail transmit), campaign
 * touches (T1/T2/T3), founder replies and evidence corrections (reply_to /
 * delivery drafts), unique prospects. Reply attribution is stated as
 * "reply occurred after Touch N", never as cause.
 *
 * The worker tick emits these once per window (`campaignDigestDue`); the
 * operator script `scripts/campaign-0908-ledger.ts` prints the same numbers.
 */
import { sql } from "@/db/client";
import { wallClock } from "@/lib/prospects/business-days";
import {
  FOLLOWUP_EXPERIMENT_ID,
  GMAIL_DAILY_SEND_CAP,
  MISMATCH_TEMPLATE_VERSION,
  REPORT_DELIVERY_TEMPLATE_VERSION,
} from "@/lib/prospects/constants";
import { OPERATOR_TIMEZONE } from "@/lib/prospects/intent";

/** Operator-local minute of day at which each digest becomes due. */
export const CAMPAIGN_DIGEST_WINDOWS = {
  preflight: { hour: 7, minute: 40 },
  ledger: { hour: 18, minute: 10 },
  /** Weekly report: Mondays after the evening ledger. */
  weekly: { weekday: 1, hour: 18, minute: 15 },
} as const;

export type SendClass = "T1" | "T2" | "T3" | "FOUNDER" | "OTHER";

export interface SendRow {
  sentAt: Date;
  prospectId: string;
  providerMessageId: string | null;
  touch: number | null;
  promptVersion: string | null;
  replyTo: string | null;
  sequenceId: string | null;
}

export function classifySend(s: SendRow): SendClass {
  if (s.replyTo || s.promptVersion === REPORT_DELIVERY_TEMPLATE_VERSION) return "FOUNDER";
  if (s.sequenceId && s.touch === 2) return "T2";
  if (s.sequenceId && s.touch === 3) return "T3";
  if (s.promptVersion === MISMATCH_TEMPLATE_VERSION) return "T1";
  return "OTHER";
}

/** Allowed Gmail sends on the given operator-local calendar days. A sent
 * draft may be a rewrite carrying no template version (2026-08-31 em-dash
 * edits); the effective version is the nearest ancestor's. */
export async function sendsOn(days: string[]): Promise<SendRow[]> {
  const rows = await sql`
    with recursive chain as (
      select d.id as sent_draft_id, d.id, d.parent_id, d.prompt_version, 0 as depth from outreach_drafts d
      union all
      select c.sent_draft_id, p.id, p.parent_id, p.prompt_version, c.depth + 1 from chain c join outreach_drafts p on p.id = c.parent_id
      where c.prompt_version is null and c.depth < 10
    ),
    effective as (select distinct on (sent_draft_id) sent_draft_id, prompt_version from chain where prompt_version is not null order by sent_draft_id, depth)
    select s.sent_at, s.prospect_id, s.provider_message_id, d.touch_number as touch,
      coalesce(d.prompt_version, e.prompt_version) as prompt_version, d.reply_to_id as reply_to, d.sequence_id
    from prospect_outreach_sends s
    left join outreach_drafts d on d.id = s.draft_id
    left join effective e on e.sent_draft_id = d.id
    where s.allowed and s.channel = 'gmail'
      and to_char(s.sent_at at time zone ${OPERATOR_TIMEZONE}, 'YYYY-MM-DD') = any(${days}::text[])
    order by s.sent_at`;
  return rows.map((r) => ({
    sentAt: new Date(r.sentAt as Date),
    prospectId: r.prospectId as string,
    providerMessageId: (r.providerMessageId as string | null) ?? null,
    touch: r.touch === null || r.touch === undefined ? null : Number(r.touch),
    promptVersion: (r.promptVersion as string | null) ?? null,
    replyTo: (r.replyTo as string | null) ?? null,
    sequenceId: (r.sequenceId as string | null) ?? null,
  }));
}

export interface CampaignLedger {
  days: string[];
  totalOutbound: number;
  campaignSends: number;
  t1: number;
  t2: number;
  t3: number;
  uniqueProspects: number;
  founderReplies: number;
  otherOutbound: number;
  transmitted: number;
  bounced: number;
  humanReplies: { businessName: string; classification: string }[];
  positiveReplies: number;
  handoffs: Record<string, number>;
  sequencesStopped: number;
  gateRefusals: number;
  capacityShortfall: number;
}

export async function campaignLedger(days: string[]): Promise<CampaignLedger> {
  const sends = await sendsOn(days);
  const n = (k: SendClass): number => sends.filter((s) => classifySend(s) === k).length;
  const campaign = sends.filter((s) => ["T1", "T2", "T3"].includes(classifySend(s)));
  const [refusals] = await sql`
    select count(*)::int as n from prospect_outreach_sends s
    where not s.allowed and s.channel = 'gmail' and to_char(s.sent_at at time zone ${OPERATOR_TIMEZONE}, 'YYYY-MM-DD') = any(${days}::text[])`;
  const [bounced] = await sql`
    select count(*)::int as n from prospect_contacts c
    where c.do_not_contact and c.do_not_contact_reason ilike 'hard_bounce%'
      and to_char(c.updated_at at time zone ${OPERATOR_TIMEZONE}, 'YYYY-MM-DD') = any(${days}::text[])`;
  const replies = await sql`
    select * from (
      select distinct on (r.prospect_id, r.received_at) r.classification, p.business_name, r.received_at
      from prospect_replies r join prospects p on p.id = r.prospect_id
      where to_char(r.received_at at time zone ${OPERATOR_TIMEZONE}, 'YYYY-MM-DD') = any(${days}::text[])
      order by r.prospect_id, r.received_at, r.created_at desc
    ) x order by x.received_at`;
  const human = replies.filter((r) => r.classification !== "out_of_office");
  const positive = human.filter((r) => ["positive_interest", "proof_request", "question", "referral"].includes(r.classification as string));
  const [stopped] = await sql`
    select count(*)::int as n from outreach_followup_sequences q
    where q.status in ('replied', 'stopped') and to_char(q.updated_at at time zone ${OPERATOR_TIMEZONE}, 'YYYY-MM-DD') = any(${days}::text[])`;
  const handoffRows = await sql`
    select status, count(*)::int as n from prospect_report_handoffs
    where to_char(created_at at time zone ${OPERATOR_TIMEZONE}, 'YYYY-MM-DD') = any(${days}::text[]) group by 1`;
  const handoffs: Record<string, number> = {};
  for (const h of handoffRows) handoffs[h.status as string] = Number(h.n);
  const cap = days.length * GMAIL_DAILY_SEND_CAP;
  return {
    days,
    totalOutbound: sends.length,
    campaignSends: campaign.length,
    t1: n("T1"), t2: n("T2"), t3: n("T3"),
    uniqueProspects: new Set(campaign.map((s) => s.prospectId)).size,
    founderReplies: n("FOUNDER"),
    otherOutbound: n("OTHER"),
    transmitted: sends.filter((s) => s.providerMessageId).length,
    bounced: Number(bounced?.n ?? 0),
    humanReplies: human.map((r) => ({ businessName: r.businessName as string, classification: r.classification as string })),
    positiveReplies: positive.length,
    handoffs,
    sequencesStopped: Number(stopped?.n ?? 0),
    gateRefusals: Number(refusals?.n ?? 0),
    capacityShortfall: Math.max(0, cap - sends.length),
  };
}

export interface CampaignPreflight {
  day: string;
  gmailSyncAgeMinutes: number | null;
  trailing24hSent: number;
  queuedToday: { t1: number; t2: number; t3: number; other: number };
  dueToday: { t2: number; t3: number };
  sequences: Record<string, number>;
  repliesSinceLastLedger: { businessName: string; classification: string }[];
  activeExclusivityAgreements: number;
  parkedDrafts: number;
}

/** Morning snapshot: what the engine will do today, read only. */
export async function campaignPreflight(now: Date = new Date()): Promise<CampaignPreflight> {
  const w = wallClock(now, OPERATOR_TIMEZONE);
  const day = `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`;
  const [gmail] = await sql`select last_sync_at from connector_connections where provider = 'gmail' limit 1`;
  const syncAge = gmail?.lastSyncAt ? Math.round((now.getTime() - new Date(gmail.lastSyncAt as Date).getTime()) / 60_000) : null;
  const [trailing] = await sql`select count(*)::int as n from prospect_outreach_sends where allowed and channel = 'gmail' and sent_at > now() - interval '24 hours'`;
  const queued = await sql`
    select coalesce(d.touch_number, case when d.prompt_version = ${MISMATCH_TEMPLATE_VERSION} then 1 else 0 end) as t, count(*)::int as n
    from outreach_drafts d where d.status = 'approved' and d.sent_recorded_at is null and d.scheduled_send_at is not null
      and to_char(d.scheduled_send_at at time zone ${OPERATOR_TIMEZONE}, 'YYYY-MM-DD') = ${day} group by 1`;
  const q = { t1: 0, t2: 0, t3: 0, other: 0 };
  for (const r of queued) {
    const t = Number(r.t);
    if (t === 1) q.t1 += Number(r.n); else if (t === 2) q.t2 += Number(r.n); else if (t === 3) q.t3 += Number(r.n); else q.other += Number(r.n);
  }
  const due = await sql`
    select next_touch, count(*)::int as n from outreach_followup_sequences
    where status = 'active' and next_due_at is not null and next_due_at <= (${day}::date + interval '1 day') group by 1`;
  const dueToday = { t2: 0, t3: 0 };
  for (const r of due) { if (Number(r.nextTouch) === 2) dueToday.t2 = Number(r.n); if (Number(r.nextTouch) === 3) dueToday.t3 = Number(r.n); }
  const seqRows = await sql`select status, count(*)::int as n from outreach_followup_sequences where experiment_id = ${FOLLOWUP_EXPERIMENT_ID} group by 1`;
  const sequences: Record<string, number> = {};
  for (const r of seqRows) sequences[r.status as string] = Number(r.n);
  const replies = await sql`
    select * from (
      select distinct on (coalesce(r.gmail_message_id, r.id::text)) r.classification, p.business_name, r.received_at
      from prospect_replies r join prospects p on p.id = r.prospect_id
      where r.received_at > now() - interval '24 hours'
      order by coalesce(r.gmail_message_id, r.id::text), r.created_at desc
    ) x order by x.received_at`;
  const [excl] = await sql`select count(*)::int as n from exclusivity_agreements where status = 'active'`;
  const [parked] = await sql`select count(*)::int as n from outreach_drafts where status = 'approved' and sent_recorded_at is null and scheduled_send_at is null and last_send_error is not null`;
  return {
    day,
    gmailSyncAgeMinutes: syncAge,
    trailing24hSent: Number(trailing?.n ?? 0),
    queuedToday: q,
    dueToday,
    sequences,
    repliesSinceLastLedger: replies.map((r) => ({ businessName: r.businessName as string, classification: r.classification as string })),
    activeExclusivityAgreements: Number(excl?.n ?? 0),
    parkedDrafts: Number(parked?.n ?? 0),
  };
}

/** Pure: which digests are due at `now` (operator-local wall clock). */
export function campaignDigestDue(now: Date): { preflight: boolean; ledger: boolean; weekly: boolean; day: string } {
  const w = wallClock(now, OPERATOR_TIMEZONE);
  const minutes = w.hour * 60 + w.minute;
  const at = (h: number, m: number): boolean => minutes >= h * 60 + m;
  const day = `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`;
  return {
    preflight: at(CAMPAIGN_DIGEST_WINDOWS.preflight.hour, CAMPAIGN_DIGEST_WINDOWS.preflight.minute),
    ledger: at(CAMPAIGN_DIGEST_WINDOWS.ledger.hour, CAMPAIGN_DIGEST_WINDOWS.ledger.minute),
    weekly: w.weekday === CAMPAIGN_DIGEST_WINDOWS.weekly.weekday && at(CAMPAIGN_DIGEST_WINDOWS.weekly.hour, CAMPAIGN_DIGEST_WINDOWS.weekly.minute),
    day,
  };
}

/** Claim a digest window once per operator-local day (weekly: once per 6
 * days) through the ops_alerts dedupe row — the same arbitration system
 * alerts use, so a restart or a second worker never double-posts. */
export async function claimCampaignDigest(kind: "campaign_preflight" | "campaign_ledger" | "campaign_weekly", message: string): Promise<boolean> {
  const rows = kind === "campaign_weekly"
    ? await sql`
        insert into ops_alerts (kind, last_sent_at, last_message) values (${kind}, now(), ${message})
        on conflict (kind) do update set last_sent_at = now(), last_message = ${message}
          where ops_alerts.last_sent_at < now() - interval '6 days'
        returning kind`
    : await sql`
        insert into ops_alerts (kind, last_sent_at, last_message) values (${kind}, now(), ${message})
        on conflict (kind) do update set last_sent_at = now(), last_message = ${message}
          where (ops_alerts.last_sent_at at time zone ${OPERATOR_TIMEZONE})::date < (now() at time zone ${OPERATOR_TIMEZONE})::date
        returning kind`;
  return rows.length > 0;
}
