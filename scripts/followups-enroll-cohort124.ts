/**
 * Spec 127: enroll the delivered competitive-mismatch Touch 1 cohort into
 * the follow-up sequence. `--dry` prints the full per-prospect validation
 * (email, name, market, competitor, production, counts, denominator,
 * branch as of now, projected local slot, subject, thread behavior, QA) and
 * the status counts without writing. Without `--dry` it enrolls every
 * eligible prospect (idempotent) and prints the projected schedule by day.
 *
 * Run: npx tsx scripts/followups-enroll-cohort124.ts [--dry] [--experiment <id>]
 */
import "dotenv/config";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import { FOLLOWUP_CADENCE_BUSINESS_DAYS, FOLLOWUP_EXPERIMENT_ID, MISMATCH_TEMPLATE_VERSION } from "@/lib/prospects/constants";
import {
  deliveredTouch1,
  distinctCompetitorQuestions,
  dueDayStart,
  enrollFollowupSequence,
  listFollowupSequences,
  marketTimezone,
  projectedSlot,
  renderNextTouch,
  sequenceForProspect,
  type FollowupSequence,
} from "@/lib/prospects/followups";
import { wallClock } from "@/lib/prospects/business-days";
import { checkSuppression } from "@/lib/outreach/suppression";
import type { MismatchEvidenceSnapshot } from "@/lib/prospects/mismatch";

const dry = process.argv.includes("--dry");
const expIdx = process.argv.indexOf("--experiment");
const EXPERIMENT_ID = expIdx >= 0 ? process.argv[expIdx + 1]! : FOLLOWUP_EXPERIMENT_ID;

function local(d: Date, tz: string): string {
  const w = wallClock(d, tz);
  return `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")} ${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")} ${tz.split("/")[1]}`;
}

async function main(): Promise<void> {
  const [u] = await sql`select id, email, name, role from users where email = 'zulumanf@gmail.com'`;
  const user = { id: u!.id, email: u!.email, name: u!.name, role: u!.role } as CurrentUser;
  const now = new Date();
  const failures: string[] = [];

  const prospects = await sql`
    select distinct on (s.prospect_id) s.prospect_id, p.business_name, l.name as launch, s.recipient_email
    from prospect_outreach_sends s
    join outreach_drafts d on d.id = s.draft_id
    join prospects p on p.id = s.prospect_id
    join market_launches l on l.id = p.launch_id
    where s.allowed and s.channel = 'gmail' and s.provider_message_id is not null
      and (d.prompt_version = ${MISMATCH_TEMPLATE_VERSION} or d.parent_id is not null)
    order by s.prospect_id, s.sent_at desc
  `;
  const delivered: Record<string, unknown>[] = [];
  for (const p of prospects) {
    const t1 = await deliveredTouch1(p.prospectId as string).catch((e: Error) => { failures.push(`${p.businessName}: ${e.message}`); return null; });
    if (!t1) continue;
    const [c] = await sql`select do_not_contact, do_not_contact_reason from prospect_contacts where id = ${t1.contactId}`;
    const [replies] = await sql`
      select count(*) filter (where classification <> 'out_of_office') as human_replies,
        count(*) filter (where classification = 'out_of_office') as ooo_replies
      from prospect_replies where prospect_id = ${p.prospectId as string} and received_at >= ${t1.sentAt}
    `;
    delivered.push({ ...p, sendId: t1.sendId, sentAt: t1.sentAt, contactId: t1.contactId, draftId: t1.draftId,
      evidenceSnapshot: t1.evidenceSnapshot, contactDnc: c?.doNotContact, doNotContactReason: c?.doNotContactReason,
      humanReplies: replies?.humanReplies, oooReplies: replies?.oooReplies });
  }

  const counts = { delivered: delivered.length, replied: 0, bounced: 0, suppressed: 0, ooo: 0, dnc: 0, eligible: 0, alreadyEnrolled: 0, t2Engaged: 0, t2NoEngagement: 0, qaFailed: 0 };
  const byDay = new Map<string, number>();

  for (const r of delivered) {
    const snapshot = r.evidenceSnapshot as MismatchEvidenceSnapshot;
    const prospectId = r.prospectId as string;
    let status = "ELIGIBLE";
    if (Number(r.humanReplies) > 0) { status = "REPLIED"; counts.replied += 1; }
    else if (/bounce/i.test((r.doNotContactReason as string | null) ?? "")) { status = "BOUNCED"; counts.bounced += 1; }
    else if (r.contactDnc) { status = "DNC"; counts.dnc += 1; }
    else if ((await checkSuppression({ email: r.recipientEmail as string, phone: null, projectId: null })).suppressed) { status = "SUPPRESSED"; counts.suppressed += 1; }
    else if (Number(r.oooReplies) > 0) { status = "OOO"; counts.ooo += 1; }
    const existing = await sequenceForProspect(prospectId, EXPERIMENT_ID);
    if (existing) counts.alreadyEnrolled += 1;
    const { tz, marketName } = await marketTimezone(prospectId);
    const sentAt = new Date(r.sentAt as Date);
    const due = dueDayStart(sentAt, FOLLOWUP_CADENCE_BUSINESS_DAYS[2], tz);
    const seq: FollowupSequence = existing ?? {
      id: prospectId, prospectId, experimentId: EXPERIMENT_ID, contactId: (r.contactId as string | null) ?? null,
      touch1DraftId: r.draftId as string, touch1SendId: r.sendId as string, touch1SentAt: sentAt, competitorCompanyId: snapshot.competitor.companyId,
      evidenceSnapshot: snapshot, distinctCompetitorQuestions: await distinctCompetitorQuestions(snapshot), timezone: tz,
      status: "active", stopReason: null, pausedUntil: null, pauseReason: null, nextTouch: 2, nextDueAt: due,
      lastTouchSendId: r.sendId as string, enrolledBy: user.id,
    };
    const slot = projectedSlot({ ...seq, status: "active" }, now);
    const touch = await renderNextTouch(seq, now);
    if (status === "ELIGIBLE") {
      counts.eligible += 1;
      if (touch?.branch === "engaged") counts.t2Engaged += 1; else counts.t2NoEngagement += 1;
      if (touch && touch.qa.length) { counts.qaFailed += 1; failures.push(`${r.businessName}: ${touch.qa.map((i) => i.detail).join(" ")}`); }
      const day = slot ? local(slot, tz).slice(0, 10) : "?";
      byDay.set(day, (byDay.get(day) ?? 0) + 1);
    }
    console.log(`\n${status.padEnd(10)} ${r.businessName}  <${r.recipientEmail}>  ${r.launch}${existing ? `  [enrolled: ${existing.status}]` : ""}`);
    console.log(`  T1 ${sentAt.toISOString()}  competitor ${snapshot.competitor.name}  ${snapshot.prospect.productionDisplay} vs ${snapshot.competitor.productionDisplay}  ` +
      `${snapshot.prospect.recommendationCount}/${snapshot.answerCount} vs ${snapshot.competitor.recommendationCount}/${snapshot.answerCount}  distinctQ=${seq.distinctCompetitorQuestions}`);
    console.log(`  tz ${tz} (${marketName})  due ${local(due, tz)}  slot ${slot ? local(slot, tz) : "-"}  ` +
      `engagement ${touch?.engagement.state ?? "-"} (${touch?.engagement.reason ?? ""})`);
    if (touch) {
      console.log(`  branch ${touch.branch}  template ${touch.version}  thread ${touch.newThread ? "NEW" : "reply"}  subject "${touch.subject}"  qa ${touch.qa.length ? "FAIL " + touch.qa.map((i) => i.detail).join(" ") : "ok"}`);
      if (dry) console.log(touch.body.split("\n").map((l) => `    | ${l}`).join("\n"));
    }
    if (!dry && status === "ELIGIBLE" && !existing) {
      const res = await enrollFollowupSequence(user, { prospectId, experimentId: EXPERIMENT_ID });
      if (!res.ok) failures.push(`${r.businessName}: enroll — ${res.error.message}`);
      else console.log(`  ENROLLED ${res.data.sequenceId} → ${res.data.status}, next due ${res.data.nextDueAt?.toISOString()}`);
    }
  }

  console.log(`\nTOTAL TOUCH 1 DELIVERED  ${counts.delivered}`);
  console.log(`ALREADY REPLIED          ${counts.replied}`);
  console.log(`BOUNCED                  ${counts.bounced}`);
  console.log(`DNC                      ${counts.dnc}`);
  console.log(`SUPPRESSED               ${counts.suppressed}`);
  console.log(`OOO                      ${counts.ooo}`);
  console.log(`ELIGIBLE FOR FOLLOW-UP   ${counts.eligible}  (already enrolled: ${counts.alreadyEnrolled})`);
  console.log(`  T2 ENGAGED             ${counts.t2Engaged}`);
  console.log(`  T2 NO ENGAGEMENT       ${counts.t2NoEngagement}`);
  console.log(`  QA FAILED              ${counts.qaFailed}`);
  console.log(`PROJECTED BY DAY (recipient-local)`);
  for (const [day, n] of [...byDay.entries()].sort()) console.log(`  ${day}  ${n}`);
  if (!dry) {
    const views = await listFollowupSequences({ experimentId: EXPERIMENT_ID }, now);
    console.log(`\nSEQUENCES ${views.length}`);
    for (const v of views) console.log(`  ${v.displayState.padEnd(18)} ${v.businessName.padEnd(40)} next ${v.nextSlot ? local(v.nextSlot, v.timezone) : "-"}`);
  }
  if (failures.length) { console.error(`\nFAILURES\n${failures.join("\n")}`); process.exitCode = 1; }
  console.log(dry ? "\n--dry: nothing written" : "\ndone");
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
