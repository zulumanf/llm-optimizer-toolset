/**
 * One-off founder follow-up to The Debbie Reed Team (warm prospect), scheduled
 * Tue 2026-09-01 09:57 ET — a free slot inside the morning window, between the
 * cohort-124 blocks. Continues the existing thread the way T2 did (same "Re:"
 * subject; the send path has no threadId support, Gmail groups by subject).
 * Observation is traceable to her frozen published audit snapshot
 * (prospect_audits 2e156d16-d372-49ed-9979-f50aae6fcd01): RE/MAX named in 52
 * of 400 answer transcripts (45 recommend a specific RE/MAX agent by name,
 * incl. "Jim Winn — RE/MAX Realty Group" ×2 on Brandywine Village/perplexity),
 * The Debbie Reed Team in 0. Dry-run by default; --apply to write.
 */
import "dotenv/config";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import { approveOutreachDraft, createOutreachDraft, scheduleDraftSend } from "@/lib/prospects/service";

const APPLY = process.argv.includes("--apply");
const PROSPECT_ID = "8ef4dcda-2ae6-44c8-85c8-e15cceb7f031";
const CONTACT_ID = "36362be9-0134-46c5-9da1-96741ff82ddd";
const SEND_AT = new Date("2026-09-01T13:57:00Z"); // 09:57 ET
const SUBJECT = "Re: A Wilmington benchmark result about The Debbie Reed Team";
const BODY = `Debbie —

I was going back through the Wilmington results and noticed one additional pattern I thought was worth sending you.

It clearly isn't a RE/MAX problem: the engines bring up RE/MAX in over fifty of the answer transcripts, usually recommending a specific RE/MAX agent by name — a couple even list agents under RE/MAX Realty Group. The brand keeps getting picked; your team is never the name attached to it.

I can send you the 2–3 clearest examples if you want to see them.

Francisco

—
Francisco Zuluaga · Recommended First
www.RecommendedFirst.com
1399 Myrtle Ave, Brooklyn, NY 11237
If you'd rather not hear from us, reply "unsubscribe" and we will not contact you again.`;

async function main(): Promise<void> {
  const [u] = await sql`select id, email, name, role from users where email = 'zulumanf@gmail.com'`;
  if (!u) throw new Error("operator user not found");
  const user: CurrentUser = {
    id: u.id as string, email: u.email as string,
    name: u.name as string, role: u.role as CurrentUser["role"],
  };

  // Safety: refuse if any send is already pending for this prospect.
  const pending = await sql`
    select id, scheduled_send_at from outreach_drafts
    where prospect_id = ${PROSPECT_ID} and sent_recorded_at is null
      and scheduled_send_at is not null`;
  if (pending.length > 0) throw new Error(`conflicting pending draft(s): ${JSON.stringify(pending)}`);

  if (!APPLY) {
    console.log(`DRY RUN — would create/approve/schedule for ${SEND_AT.toISOString()}:\n\n${SUBJECT}\n\n${BODY}`);
    return;
  }

  const created = await createOutreachDraft(user, {
    prospectId: PROSPECT_ID,
    channel: "followup_email",
    contactId: CONTACT_ID,
    subject: SUBJECT,
    body: BODY,
    tone: "founder-manual-warm-followup",
    cta: "reply if you want the 2–3 clearest examples",
  });
  if (!created.ok) throw new Error(`create failed: ${created.error.message}`);
  console.log(`draft ${created.data.draftId} v${created.data.version}`);

  const approved = await approveOutreachDraft(user, { draftId: created.data.draftId });
  if (!approved.ok) throw new Error(`approve (QA) failed: ${approved.error.message}`);
  console.log("approved (QA passed)");

  const sched = await scheduleDraftSend(user, {
    draftId: created.data.draftId,
    sendAt: SEND_AT,
    businessPurpose:
      "Founder-led manual follow-up to warmest prospect (The Debbie Reed Team): shares one additional evidence-backed observation from her existing frozen audit (RE/MAX named in 52/400 transcripts, her team in 0); low-friction reply CTA, no meeting ask. Not the standard T3 template.",
  });
  if (!sched.ok) throw new Error(`schedule failed: ${sched.error.message}`);
  console.log(`scheduled for ${sched.data.sendAt}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
