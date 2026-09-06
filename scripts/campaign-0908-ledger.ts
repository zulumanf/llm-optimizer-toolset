/**
 * Campaign week 2026-09-08: deterministic daily and weekly ledgers read
 * from the send ledger, sequence table, reply table and handoff table.
 * Counts are DISTINCT by definition: total outbound (every allowed Gmail
 * transmit), campaign touches (T1/T2/T3), founder replies (reply_to /
 * report delivery drafts), unique prospects. Reply attribution is stated
 * as "reply occurred after Touch N", never as cause.
 *
 * Run: npx tsx scripts/campaign-0908-ledger.ts --day 2026-09-08
 *      npx tsx scripts/campaign-0908-ledger.ts --week
 */
import "dotenv/config";
import { sql } from "@/db/client";
import { FOLLOWUP_EXPERIMENT_ID, GMAIL_DAILY_SEND_CAP, MISMATCH_TEMPLATE_VERSION, REPORT_DELIVERY_TEMPLATE_VERSION } from "@/lib/prospects/constants";
import { followupMetrics, listFollowupSequences } from "@/lib/prospects/followups";

const ET = "America/New_York";
const WEEK = ["2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11", "2026-09-14"];
const dayArg = (): string | null => { const i = process.argv.indexOf("--day"); return i >= 0 ? process.argv[i + 1]! : null; };

interface SendRow { sentAt: Date; prospectId: string; email: string | null; providerMessageId: string | null; touch: number | null; promptVersion: string | null; replyTo: string | null; sequenceId: string | null }

async function sendsOn(days: string[]): Promise<SendRow[]> {
  // A sent draft may be a rewrite carrying no template version (2026-08-31
  // em-dash edits); the effective version is the nearest ancestor's.
  const rows = await sql`
    with recursive chain as (
      select d.id as sent_draft_id, d.id, d.parent_id, d.prompt_version, 0 as depth from outreach_drafts d
      union all
      select c.sent_draft_id, p.id, p.parent_id, p.prompt_version, c.depth + 1 from chain c join outreach_drafts p on p.id = c.parent_id
      where c.prompt_version is null and c.depth < 10
    ),
    effective as (select distinct on (sent_draft_id) sent_draft_id, prompt_version from chain where prompt_version is not null order by sent_draft_id, depth)
    select s.sent_at, s.prospect_id, s.recipient_email as email, s.provider_message_id, d.touch_number as touch, coalesce(d.prompt_version, e.prompt_version) as prompt_version, d.reply_to_id as reply_to, d.sequence_id
    from prospect_outreach_sends s left join outreach_drafts d on d.id = s.draft_id left join effective e on e.sent_draft_id = d.id
    where s.allowed and s.channel = 'gmail' and to_char(s.sent_at at time zone ${ET}, 'YYYY-MM-DD') = any(${days}::text[])
    order by s.sent_at`;
  return rows.map((r) => ({ sentAt: new Date(r.sentAt as Date), prospectId: r.prospectId as string, email: (r.email as string | null) ?? null, providerMessageId: (r.providerMessageId as string | null) ?? null, touch: r.touch === null ? null : Number(r.touch), promptVersion: (r.promptVersion as string | null) ?? null, replyTo: (r.replyTo as string | null) ?? null, sequenceId: (r.sequenceId as string | null) ?? null }));
}

function classify(s: SendRow): "T1" | "T2" | "T3" | "FOUNDER" | "OTHER" {
  if (s.replyTo || s.promptVersion === REPORT_DELIVERY_TEMPLATE_VERSION) return "FOUNDER";
  if (s.sequenceId && s.touch === 2) return "T2";
  if (s.sequenceId && s.touch === 3) return "T3";
  if (s.promptVersion === MISMATCH_TEMPLATE_VERSION) return "T1";
  return "OTHER";
}

async function ledger(days: string[], label: string): Promise<void> {
  const sends = await sendsOn(days);
  const by = (k: ReturnType<typeof classify>): SendRow[] => sends.filter((s) => classify(s) === k);
  const campaign = sends.filter((s) => ["T1", "T2", "T3"].includes(classify(s)));
  const refusals = await sql`
    select count(*)::int as n from prospect_outreach_sends s
    where not s.allowed and s.channel = 'gmail' and to_char(s.sent_at at time zone ${ET}, 'YYYY-MM-DD') = any(${days}::text[])`;
  const bounced = await sql`
    select count(*)::int as n from prospect_contacts c
    where c.do_not_contact and c.do_not_contact_reason ilike 'hard_bounce%' and to_char(c.updated_at at time zone ${ET}, 'YYYY-MM-DD') = any(${days}::text[])`;
  const replies = await sql`
    select * from (
      select distinct on (coalesce(r.gmail_message_id, r.id::text)) r.classification, p.business_name, r.received_at
      from prospect_replies r join prospects p on p.id = r.prospect_id
      where to_char(r.received_at at time zone ${ET}, 'YYYY-MM-DD') = any(${days}::text[])
      order by coalesce(r.gmail_message_id, r.id::text), r.created_at desc
    ) x order by x.received_at`;
  const human = replies.filter((r) => r.classification !== "out_of_office");
  const positive = human.filter((r) => ["positive_interest", "proof_request", "question", "referral"].includes(r.classification as string));
  const stopped = await sql`
    select count(*)::int as n from outreach_followup_sequences q
    where q.status in ('replied', 'stopped') and to_char(q.updated_at at time zone ${ET}, 'YYYY-MM-DD') = any(${days}::text[])`;
  const handoffs = await sql`
    select status, count(*)::int as n from prospect_report_handoffs
    where to_char(created_at at time zone ${ET}, 'YYYY-MM-DD') = any(${days}::text[]) group by 1`;
  const cap = days.length * GMAIL_DAILY_SEND_CAP;
  console.log(`\n${label}`);
  console.log(`  TOTAL OUTBOUND            ${sends.length}`);
  console.log(`  CAMPAIGN SENDS            ${campaign.length}  (T1 ${by("T1").length} · T2 ${by("T2").length} · T3 ${by("T3").length})`);
  console.log(`  UNIQUE PROSPECTS TOUCHED  ${new Set(campaign.map((s) => s.prospectId)).size}`);
  console.log(`  FOUNDER/HUMAN REPLIES     ${by("FOUNDER").length}${by("OTHER").length ? `  (other outbound ${by("OTHER").length})` : ""}`);
  console.log(`  TRANSMITTED (Gmail id)    ${sends.filter((s) => s.providerMessageId).length}`);
  console.log(`  BOUNCED (hard, marked)    ${Number(bounced[0]?.n ?? 0)}`);
  console.log(`  HUMAN REPLIES RECEIVED    ${human.length}${human.length ? "  — " + human.map((r) => `${r.businessName} (${r.classification})`).join("; ") : ""}`);
  console.log(`  POSITIVE REPLIES          ${positive.length}`);
  console.log(`  REPORT REQUESTS/HANDOFFS  ${handoffs.map((h) => `${h.status} ${h.n}`).join(", ") || 0}`);
  console.log(`  SEQUENCES STOPPED         ${Number(stopped[0]?.n ?? 0)}`);
  console.log(`  GATE REFUSALS (QA/cap)    ${Number(refusals[0]?.n ?? 0)}`);
  console.log(`  CAPACITY vs ${cap} cap       ${sends.length < cap ? `CAPACITY_SHORTFALL ${cap - sends.length}` : "at cap"}`);
}

async function main(): Promise<void> {
  const day = dayArg();
  if (day) await ledger([day], `DAILY LEDGER ${day} (ET)`);
  else {
    for (const d of WEEK) await ledger([d], `DAILY LEDGER ${d} (ET)`);
    await ledger(WEEK, "WEEKLY LEDGER Tue 09-08 → Mon 09-14 (ET)");
    const m = await followupMetrics(FOLLOWUP_EXPERIMENT_ID);
    const views = await listFollowupSequences({ experimentId: FOLLOWUP_EXPERIMENT_ID });
    const entered = views.length;
    console.log(`\nEXPERIMENT ${FOLLOWUP_EXPERIMENT_ID} (all time)`);
    console.log(`  UNIQUE PROSPECTS ENTERED (T1 delivered + enrolled)  ${entered}`);
    console.log(`  DELIVERED  T1 ${m.delivered.t1} · T2 ${m.delivered.t2} · T3 ${m.delivered.t3}`);
    console.log(`  HUMAN REPLIES ${m.humanReplies} · POSITIVE ${m.positiveReplies} · NEGATIVE ${m.negativeReplies} · BOUNCED ${m.bounced} · DNC ${m.dnc}`);
    console.log(`  POSITIVE REPLY RATE (positive / entered)  ${entered ? (m.positiveReplies / entered * 100).toFixed(1) : "-"}%`);
    console.log(`  FIRST REPLY OCCURRED AFTER TOUCH  ${JSON.stringify(m.firstReplyAfterTouch)}`);
    console.log(`  BY TEMPLATE  ${JSON.stringify(m.byBranch)}`);
    const handoffs = views.filter((v) => v.handoff).map((v) => `${v.businessName}: ${v.handoff!.reportState}`);
    console.log(`  REPORT HANDOFFS  ${handoffs.length ? handoffs.join("; ") : "none"}`);
    console.log(`  Attribution note: "reply occurred after Touch N" — no touch is claimed as the cause.`);
  }
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
