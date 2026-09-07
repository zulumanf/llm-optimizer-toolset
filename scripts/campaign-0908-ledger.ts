/**
 * Campaign week 2026-09-08: print the daily and weekly ledgers the worker
 * also emits (lib/prospects/campaign-ledger). Same numbers, same
 * definitions; this is the operator's on-demand view.
 *
 * Run: npx tsx scripts/campaign-0908-ledger.ts --day 2026-09-08
 *      npx tsx scripts/campaign-0908-ledger.ts --preflight
 *      npx tsx scripts/campaign-0908-ledger.ts --week
 */
import "dotenv/config";
import { sql } from "@/db/client";
import { campaignLedger, campaignPreflight, type CampaignLedger } from "@/lib/prospects/campaign-ledger";
import { FOLLOWUP_EXPERIMENT_ID, GMAIL_DAILY_SEND_CAP } from "@/lib/prospects/constants";
import { followupMetrics, listFollowupSequences } from "@/lib/prospects/followups";

const WEEK = ["2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11", "2026-09-14"];
const dayArg = (): string | null => { const i = process.argv.indexOf("--day"); return i >= 0 ? process.argv[i + 1]! : null; };

function print(l: CampaignLedger, label: string): void {
  console.log(`\n${label}`);
  console.log(`  TOTAL OUTBOUND            ${l.totalOutbound}`);
  console.log(`  CAMPAIGN SENDS            ${l.campaignSends}  (T1 ${l.t1} · T2 ${l.t2} · T3 ${l.t3})`);
  console.log(`  UNIQUE PROSPECTS TOUCHED  ${l.uniqueProspects}`);
  console.log(`  FOUNDER/HUMAN REPLIES     ${l.founderReplies}${l.otherOutbound ? `  (other outbound ${l.otherOutbound})` : ""}`);
  console.log(`  TRANSMITTED (Gmail id)    ${l.transmitted}`);
  console.log(`  BOUNCED (hard, marked)    ${l.bounced}`);
  console.log(`  HUMAN REPLIES RECEIVED    ${l.humanReplies.length}${l.humanReplies.length ? "  — " + l.humanReplies.map((r) => `${r.businessName} (${r.classification})`).join("; ") : ""}`);
  console.log(`  POSITIVE REPLIES          ${l.positiveReplies}`);
  console.log(`  REPORT REQUESTS/HANDOFFS  ${Object.entries(l.handoffs).map(([k, v]) => `${k} ${v}`).join(", ") || 0}`);
  console.log(`  SEQUENCES STOPPED         ${l.sequencesStopped}`);
  console.log(`  GATE REFUSALS (QA/cap)    ${l.gateRefusals}`);
  console.log(`  CAPACITY vs ${l.days.length * GMAIL_DAILY_SEND_CAP} cap       ${l.capacityShortfall > 0 ? `CAPACITY_SHORTFALL ${l.capacityShortfall}` : "at cap"}`);
}

async function main(): Promise<void> {
  const day = dayArg();
  if (process.argv.includes("--preflight")) {
    console.log(JSON.stringify(await campaignPreflight(), null, 2));
  } else if (day) {
    print(await campaignLedger([day]), `DAILY LEDGER ${day} (ET)`);
  } else {
    for (const d of WEEK) print(await campaignLedger([d]), `DAILY LEDGER ${d} (ET)`);
    print(await campaignLedger(WEEK), "WEEKLY LEDGER Tue 09-08 → Mon 09-14 (ET)");
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
