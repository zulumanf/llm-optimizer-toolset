/**
 * 2026-09-05 one-off (spec 130): Ryan Ogle's inbound reply was ingested as
 * its subject line (HTML-only message, adapter decoded text/plain only) and
 * classified `unclear`. Record the actual words as a correction row on the
 * insert-only ledger (the original row stays), set the founder action and
 * the structured intent signals. Nothing is sent; no sequence is enrolled
 * (autosend is on, and a sequence would arm the spec 129 handoff).
 *
 * Run: npx tsx scripts/ryan-ogle-reply-fix-0905.ts [--apply]
 */
import "dotenv/config";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import { logActivity } from "@/lib/prospects/shared";
import { recordProspectReply, updateProspect } from "@/lib/prospects/service";
import { classifyReplyText } from "@/lib/prospects/reply-classify";

const APPLY = process.argv.includes("--apply");
const PROSPECT = "ba4860d6-3118-4a42-8af1-7bedbb2e27a0";
const CONTACT = "bff98a98-369f-42ed-adc0-343595009737";
const SEND = "7629124a-def6-496f-b6fa-007aaf1556dc";
const ORIGINAL_REPLY = "6c30b27c-d4ce-4df2-b15c-f11c924db7f2";
const GMAIL_MESSAGE_ID = "1a07210fa0422404";
const RECEIVED_AT = new Date("2026-09-05T14:54:57.000Z");
// Verbatim from the Gmail thread (text/html part, quoted Touch 1 stripped).
const BODY = [
  `[correction of ${ORIGINAL_REPLY.slice(0, 8)} / Gmail ${GMAIL_MESSAGE_ID}: the row was ingested with the subject line only (HTML-only message; adapter fixed in spec 130). Actual reply:]`,
  "",
  "Send them and show me how you get me ranked higher. Don’t sell me. Show me something easy and tangible.",
  "",
  "Spell out your pricing and I will review and consider.",
  "",
  "Ryan Ogle - Blu House Properties - 616.901.4541 or ryan@thinkbluhouse.com",
].join("\n");

async function main(): Promise<void> {
  const [u] = await sql`select id, email, name, role from users where id = '2a01d915-35ad-40bb-94cc-78a86d3619ba'`;
  const user = { id: u!.id as string, email: u!.email as string, name: (u!.name as string | null) ?? null, role: u!.role as CurrentUser["role"] } as CurrentUser;
  console.log(`classifier on the actual words: ${classifyReplyText(BODY.split("\n").slice(2).join("\n"))}`);
  const existing = await sql`select id, classification, left(body_text, 60) as head from prospect_replies where prospect_id = ${PROSPECT} order by received_at, created_at`;
  console.log("ledger before:", JSON.stringify(existing));
  if (!APPLY) { console.log("dry run; pass --apply"); await sql.end(); return; }
  if (existing.some((r) => (r.head as string).startsWith("[correction of"))) {
    console.log("correction row already present; skipping insert");
  } else {
    const rec = await recordProspectReply(user, {
      prospectId: PROSPECT, contactId: CONTACT, sendId: SEND, bodyText: BODY, receivedAt: RECEIVED_AT,
      classification: "positive_interest",
    });
    if (!rec.ok) throw new Error(rec.error.message);
    console.log(`correction reply recorded ${rec.data.replyId} (${rec.data.classification}), stageAdvanced=${rec.data.stageAdvanced}`);
  }
  const upd = await updateProspect(user, {
    prospectId: PROSPECT,
    nextAction: "HIGH · CORRECT REPORT + RESPOND: review corrected report (29 vs 38 of 256), fill [FOUNDER_PRICING], send reply draft in thread",
    nextActionOn: "2026-09-05",
  });
  console.log(`next action set: ${upd.ok ? "ok" : upd.error.message}`);
  await sql.begin(async (tx) => {
    await logActivity(tx, PROSPECT, "founder_action_required", {
      action: "correct_report_and_respond", priority: "high", replyId: ORIGINAL_REPLY, gmailMessageId: GMAIL_MESSAGE_ID,
      state: "POSITIVE_INTEREST_HIGH_INTENT", note: "Cold sequence never enrolled (Saturday T1); spec 129 handoff deliberately not armed while autosend is on. Founder sends.",
    }, user.id);
    await logActivity(tx, PROSPECT, "commercial_intent_signals", {
      replyId: ORIGINAL_REPLY, requested_evidence: true, requested_how_it_works: true, requested_tangible_action: true,
      requested_pricing: true, explicit_no_sales_pitch: true, provided_phone: true, phone: "616.901.4541",
    }, user.id);
  });
  console.log("activities logged");
  const after = await sql`select id, classification, received_at, gmail_message_id, left(body_text, 70) as head from prospect_replies where prospect_id = ${PROSPECT} order by received_at, created_at`;
  console.log("ledger after:", JSON.stringify(after, null, 1));
  const [p] = await sql`select stage, next_action, next_action_on from prospects where id = ${PROSPECT}`;
  console.log("prospect:", JSON.stringify(p));
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
