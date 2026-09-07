/**
 * 2026-09-05: founder-authorized single dispatch of Ryan Ogle's reply draft
 * c9de2350 through the normal approve → send path (gate, ledger, Gmail
 * threading under his inbound reply via reply_to_id). Refuses if the draft
 * already has a recorded send.
 */
import "dotenv/config";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import { approveOutreachDraft, sendProspectDraft, transitionStage, updateProspect } from "@/lib/prospects/service";
const D = "c9de2350-faf5-46e5-9ad7-8043b23faab3", P = "ba4860d6-3118-4a42-8af1-7bedbb2e27a0", U = "2a01d915-35ad-40bb-94cc-78a86d3619ba";
async function main(): Promise<void> {
  const [u] = await sql`select id, email, name, role from users where id = ${U}`;
  const user = { id: u!.id as string, email: u!.email as string, name: (u!.name as string | null) ?? null, role: u!.role as CurrentUser["role"] } as CurrentUser;
  const [d] = await sql`select status, sent_recorded_at from outreach_drafts where id = ${D}`;
  if (d!.sentRecordedAt) throw new Error(`already sent at ${d!.sentRecordedAt}`);
  if (d!.status === "draft") {
    const a = await approveOutreachDraft(user, { draftId: D });
    if (!a.ok) throw new Error(`approve refused: ${a.error.message}`);
    console.log("approved");
  }
  const s = await sendProspectDraft(user, {
    draftId: D, channel: "gmail",
    businessPurpose: "Founder-authorized reply to Ryan Ogle's 2026-09-05 inbound request for the evidence, tangible actions and pricing (spec 130 corrected report); threaded under his reply.",
  });
  if (!s.ok) throw new Error(`send refused: ${s.error.message}`);
  console.log("SENT", JSON.stringify(s.data));
  const [send] = await sql`select id, sent_at, provider_message_id, gmail_thread_id, recipient_email, gate_verdict->'checks' as checks from prospect_outreach_sends where draft_id = ${D}`;
  console.log("LEDGER", JSON.stringify({ id: send!.id, sentAt: send!.sentAt, providerMessageId: send!.providerMessageId, gmailThreadId: send!.gmailThreadId, to: send!.recipientEmail }));
  console.log("GATE", JSON.stringify((send!.checks as { name: string; passed: boolean; detail: string }[]).map((c) => `${c.name}:${c.passed ? "ok" : "FAIL"}`)));
  const st = await transitionStage(user, { prospectId: P, toStage: "audit_sent", reason: "Corrected private report + pricing sent in thread by the founder (spec 130)." });
  console.log("stage:", st.ok ? st.data.stage : st.error.message);
  const na = await updateProspect(user, { prospectId: P, nextAction: "Await Ryan's reply (report + $7,500/mo × 3 pricing sent 2026-09-05). Email only; no call/text; no automated follow-ups. Surface any reply to Francisco immediately.", nextActionOn: "2026-09-08" });
  console.log("next action:", na.ok ? "ok" : na.error.message);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
