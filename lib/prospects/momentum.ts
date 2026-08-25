/**
 * Momentum scoreboard reads (spec 119). Input-first metrics for the Operate
 * tab: daily send volume against the quota, streaks, refusals, first replies
 * per day, and draft throughput. All-cohort on purpose — effort is global,
 * whatever cohort the operator is looking at. Same discipline as the rest of
 * the cockpit: read-only, derive on read, never persist an interpretation.
 */
import { sql } from "@/db/client";
import {
  OPERATOR_TIMEZONE,
  startOfOperatorDay,
  type ProspectIntent,
} from "@/lib/prospects/intent";

export const MOMENTUM_WINDOW_DAYS = 30;
export const THROUGHPUT_WINDOW_DAYS = 7;

const DAY_KEY = new Intl.DateTimeFormat("en-CA", {
  timeZone: OPERATOR_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const WEEKDAY = new Intl.DateTimeFormat("en-US", { timeZone: OPERATOR_TIMEZONE, weekday: "short" });

/** Calendar day (YYYY-MM-DD) in the operator's timezone. */
export const operatorDayKey = (d: Date): string => DAY_KEY.format(d);
export const isBusinessDay = (d: Date): boolean => !["Sat", "Sun"].includes(WEEKDAY.format(d));

export interface MomentumDayInput {
  day: string;
  firstTouch: number;
  followUps: number;
  refused: number;
  replies: number;
}

export interface MomentumDay extends MomentumDayInput {
  isBusinessDay: boolean;
  isToday: boolean;
}

/** The trailing `windowDays` operator days, oldest first. Anchored at local
 * noon so a DST shift can never skip or double a day. */
export function dayKeys(now: Date, windowDays: number = MOMENTUM_WINDOW_DAYS): { key: string; isBusinessDay: boolean }[] {
  const noon = new Date(startOfOperatorDay(now).getTime() + 12 * 3_600_000);
  return Array.from({ length: windowDays }, (_, i) => {
    const d = new Date(noon.getTime() - (windowDays - 1 - i) * 86_400_000);
    return { key: operatorDayKey(d), isBusinessDay: isBusinessDay(d) };
  });
}

/** Complete calendar over the window: absent days are zero-activity days,
 * not missing days — a gap in the chart must mean "nothing was sent". */
export function fillDailySeries(
  rows: MomentumDayInput[],
  now: Date,
  windowDays: number = MOMENTUM_WINDOW_DAYS
): MomentumDay[] {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const today = operatorDayKey(now);
  return dayKeys(now, windowDays).map(({ key, isBusinessDay: biz }) => ({
    day: key,
    firstTouch: byDay.get(key)?.firstTouch ?? 0,
    followUps: byDay.get(key)?.followUps ?? 0,
    refused: byDay.get(key)?.refused ?? 0,
    replies: byDay.get(key)?.replies ?? 0,
    isBusinessDay: biz,
    isToday: key === today,
  }));
}

/** Consecutive business days at or above the quota, newest backwards.
 * Weekends neither count nor break; today only breaks the streak once it is
 * over, so an in-progress morning shows yesterday's streak, not zero. */
export function quotaStreak(days: MomentumDay[], quota: number): number {
  let streak = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    const d = days[i]!;
    if (!d.isBusinessDay) continue;
    if (d.firstTouch + d.followUps >= quota) streak++;
    else if (d.isToday) continue;
    else break;
  }
  return streak;
}

export interface TouchDepthRow {
  depth: "1 touch" | "2 touches" | "3+ touches";
  prospects: number;
  replied: number;
}

/** Contacted prospects by how deep the sequence went, and how many are
 * sitting at one touch with no reply and a follow-up already due — the
 * prospects the cadence says are being under-worked. */
export function touchDepthDistribution(items: ProspectIntent[]): {
  rows: TouchDepthRow[];
  contacted: number;
  stalledAtOne: number;
} {
  const contacted = items.filter((p) => p.sales.contacted);
  const bucket = (t: number): TouchDepthRow["depth"] => (t >= 3 ? "3+ touches" : t === 2 ? "2 touches" : "1 touch");
  const rows: TouchDepthRow[] = (["1 touch", "2 touches", "3+ touches"] as const).map((depth) => ({
    depth,
    prospects: contacted.filter((p) => bucket(p.sales.touches) === depth).length,
    replied: contacted.filter((p) => bucket(p.sales.touches) === depth && p.sales.replied).length,
  }));
  return {
    rows,
    contacted: contacted.length,
    stalledAtOne: contacted.filter((p) => p.sales.touches === 1 && !p.sales.replied && p.followUpDue).length,
  };
}

/** Median hours from the first send to the first recorded reply. */
export function medianHoursToFirstReply(items: ProspectIntent[]): { hours: number | null; n: number } {
  const deltas = items
    .filter((p) => p.repliedAt !== null && p.sentAts.length > 0 && p.repliedAt.getTime() >= p.sentAts[0]!.getTime())
    .map((p) => (p.repliedAt!.getTime() - p.sentAts[0]!.getTime()) / 3_600_000)
    .sort((a, b) => a - b);
  if (deltas.length === 0) return { hours: null, n: 0 };
  const mid = Math.floor(deltas.length / 2);
  const hours = deltas.length % 2 === 1 ? deltas[mid]! : (deltas[mid - 1]! + deltas[mid]!) / 2;
  return { hours, n: deltas.length };
}

export interface DraftThroughput {
  created: number;
  approved: number;
  sent: number;
  refused: number;
  /** Median hours from draft creation to approval, trailing 30 days. */
  medianApprovalHours: number | null;
}

export interface Momentum {
  days: MomentumDay[];
  throughput: DraftThroughput;
}

export async function momentum(now: Date = new Date()): Promise<Momentum> {
  const since = new Date(startOfOperatorDay(now).getTime() - (MOMENTUM_WINDOW_DAYS - 1) * 86_400_000);
  // Sequential on purpose — same pooler session cap machineHealth hit.
  const dailyRows = await sql`
    with ordered as (
      select s.sent_at,
        row_number() over (partition by s.prospect_id order by s.sent_at) as touch
      from prospect_outreach_sends s
      where s.allowed
    ),
    sends_daily as (
      select (o.sent_at at time zone ${OPERATOR_TIMEZONE})::date::text as day,
        count(*) filter (where o.touch = 1)::int as first_touch,
        count(*) filter (where o.touch > 1)::int as follow_ups
      from ordered o where o.sent_at >= ${since}
      group by 1
    ),
    refused_daily as (
      select (s.sent_at at time zone ${OPERATOR_TIMEZONE})::date::text as day, count(*)::int as refused
      from prospect_outreach_sends s
      where not s.allowed and s.sent_at >= ${since}
      group by 1
    ),
    first_reply as (
      -- Same ladder cut as prospectFacts (dashboard.ts): any of these stages
      -- means a conversation happened, so the first arrival is "first reply".
      select h.prospect_id, min(h.changed_at) as at
      from prospect_stage_history h
      where h.to_stage in ('replied','discovery_scheduled','discovery_completed','proposal_sent','negotiation','verbal_yes','contracted')
      group by h.prospect_id
    ),
    replies_daily as (
      select (r.at at time zone ${OPERATOR_TIMEZONE})::date::text as day, count(*)::int as replies
      from first_reply r where r.at >= ${since}
      group by 1
    )
    select coalesce(s.day, x.day, r.day) as day,
      coalesce(s.first_touch, 0) as first_touch,
      coalesce(s.follow_ups, 0) as follow_ups,
      coalesce(x.refused, 0) as refused,
      coalesce(r.replies, 0) as replies
    from sends_daily s
    full join refused_daily x using (day)
    full join replies_daily r using (day)
  `;
  const [t] = await sql`
    select
      (select count(*)::int from outreach_drafts
        where created_at >= now() - make_interval(days => ${THROUGHPUT_WINDOW_DAYS})) as created,
      (select count(*)::int from outreach_drafts
        where approved_at >= now() - make_interval(days => ${THROUGHPUT_WINDOW_DAYS})) as approved,
      (select count(*)::int from prospect_outreach_sends
        where allowed and sent_at >= now() - make_interval(days => ${THROUGHPUT_WINDOW_DAYS})) as sent,
      (select count(*)::int from prospect_outreach_sends
        where not allowed and sent_at >= now() - make_interval(days => ${THROUGHPUT_WINDOW_DAYS})) as refused,
      (select percentile_cont(0.5) within group (order by extract(epoch from (approved_at - created_at)))
        from outreach_drafts
        where approved_at is not null and approved_at >= now() - interval '30 days') as median_approval_secs
  `;
  return {
    days: fillDailySeries(
      dailyRows.map((r) => ({
        day: r.day as string,
        firstTouch: Number(r.firstTouch ?? 0),
        followUps: Number(r.followUps ?? 0),
        refused: Number(r.refused ?? 0),
        replies: Number(r.replies ?? 0),
      })),
      now
    ),
    throughput: {
      created: Number(t?.created ?? 0),
      approved: Number(t?.approved ?? 0),
      sent: Number(t?.sent ?? 0),
      refused: Number(t?.refused ?? 0),
      medianApprovalHours:
        t?.medianApprovalSecs === null || t?.medianApprovalSecs === undefined
          ? null
          : Number(t.medianApprovalSecs) / 3600,
    },
  };
}
