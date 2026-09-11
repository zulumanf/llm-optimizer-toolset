/**
 * 2026-09-07: founder-authorized close-out reply to Ryan Ogle's price
 * decline (reply row bad619ae, Gmail 1a07b6e7554e9e7d), threaded under it
 * through the normal draft → QA → approve → gated Gmail send path. Human
 * conversation (priority 0), not a campaign touch. Refuses if already sent.
 */
import "dotenv/config";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import { qaDraft } from "@/lib/prospects/draft-qa";
import { approveOutreachDraft, sendProspectDraft, updateProspect } from "@/lib/prospects/service";
const P = "ba4860d6-3118-4a42-8af1-7bedbb2e27a0";
const SUBJECT = "Re: Ryan - Grand Rapids";
const BODY = [
  "Ryan,", "",
  "Totally understand. I appreciate you being straightforward with me.", "",
  "Thanks for taking the time to look through what I put together, and I hope the findings are useful as you work on it internally.", "",
  "If you ever want me to take another look down the road, feel free to reach out.", "",
  "Francisco", "",
  "--",
  "Francisco Zuluaga · Recommended First",
  "www.RecommendedFirst.com",
  "Brooklyn, NY",
  'If you\'d rather not hear from us, reply "unsubscribe" and we will not contact you again.',
].join("\n");
async function main(): Promise<void> {
  const [u] = await sql`select id, email, name, role from users where email = 'zulumanf@gmail.com'`;
  const user = { id: u!.id, email: u!.email, name: u!.name, role: u!.role } as CurrentUser;
  const [reply] = await sql`select id, gmail_message_id from prospect_replies where prospect_id = ${P} and id::text like 'bad619ae%'`;
  if (!reply?.gmailMessageId) throw new Error("reply row without a Gmail id");
  const [already] = await sql`select d.id from outreach_drafts d join prospect_outreach_sends s on s.draft_id = d.id where d.reply_to_id = ${reply.id} and s.allowed`;
  if (already) throw new Error(`already replied to this message (draft ${already.id})`);
  const [row] = await sql`
    insert into outreach_drafts (prospect_id, finding_id, channel, contact_id, version, subject, body, tone, cta, generated_by, prompt_version, status, created_by, reply_to_id)
    select d.prospect_id, d.finding_id, d.channel, d.contact_id, (select coalesce(max(version), 0) + 1 from outreach_drafts where prospect_id = ${P}),
      ${SUBJECT}, ${BODY}, 'warm, brief, no pressure', 'Close the loop; door left open; no ask', 'operator', null, 'draft', ${user.id}, ${reply.id}
    from outreach_drafts d where d.prospect_id = ${P} and d.reply_to_id is not null order by d.created_at desc limit 1
    returning id`;
  const id = row!.id as string;
  const issues = await qaDraft(id);
  if (issues.length) throw new Error("QA: " + issues.map((i) => `[${i.check}] ${i.detail}`).join(" "));
  const a = await approveOutreachDraft(user, { draftId: id });
  if (!a.ok) throw new Error(`approve refused: ${a.error.message}`);
  const s = await sendProspectDraft(user, { draftId: id, channel: "gmail", businessPurpose: "Founder-authorized close-out reply (2026-09-07) to Ryan Ogle's price decline; warm human conversation, threaded under his reply; no campaign touch." });
  if (!s.ok) throw new Error(`send refused: ${s.error.message}`);
  const [send] = await sql`select id, sent_at, provider_message_id, gmail_thread_id, recipient_email, gate_verdict->'checks' as checks from prospect_outreach_sends where draft_id = ${id}`;
  console.log("SENT", JSON.stringify({ draft: id.slice(0, 8), sentAt: send!.sentAt, gmail: send!.providerMessageId, thread: send!.gmailThreadId, to: send!.recipientEmail }));
  console.log("GATE", (send!.checks as { name: string; passed: boolean }[]).map((c) => `${c.name}:${c.passed ? "ok" : "FAIL"}`).join(" "));
  const na = await updateProspect(user, { prospectId: P, nextAction: "Closed warmly 2026-09-07 after price decline; door left open. No follow-ups. Reopen only if Ryan writes back.", nextActionOn: "2026-10-05" });
  console.log("next action:", na.ok ? "ok" : na.error.message);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
