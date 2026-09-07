/**
 * 2026-08-26: two Annapolis drafts scheduled for Thu carry the pre-fix
 * article bug in the subject ("A Annapolis…" — drafted before commit
 * 496595d fixed a/an for vowel-initial markets). Supersede each with an
 * identical draft whose subject reads "An Annapolis…", QA-approve, and
 * reschedule at whatever slot the draft currently holds (so this composes
 * with the 07:30 reschedule in either order). Dry-run; --apply to write.
 */
import "dotenv/config";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import { approveOutreachDraft, createOutreachDraft, scheduleDraftSend } from "@/lib/prospects/service";

const APPLY = process.argv.includes("--apply");
const PURPOSE = "Subject article fix (A → An Annapolis); body, contact, and schedule unchanged.";

async function main(): Promise<void> {
  const [u] = await sql`select id, email, name, role from users where email = 'zulumanf@gmail.com'`;
  if (!u) throw new Error("operator user not found");
  const user: CurrentUser = { id: u.id as string, email: u.email as string, name: u.name as string, role: u.role as CurrentUser["role"] };

  const rows = await sql`select d.id, d.prospect_id, d.channel, d.subject, d.body, d.contact_id, d.scheduled_send_at, p.business_name
    from outreach_drafts d join prospects p on p.id = d.prospect_id
    where d.status = 'approved' and d.sent_recorded_at is null and d.scheduled_send_at > now()
      and d.subject like 'A Annapolis%'`;
  console.log(`${rows.length} drafts with the article bug${APPLY ? "" : " (dry-run)"}`);
  for (const r of rows) {
    const subject = (r.subject as string).replace(/^A Annapolis/, "An Annapolis");
    const slot = new Date(r.scheduledSendAt as Date);
    if (!APPLY) { console.log(`would fix: ${r.businessName} → "${subject}" @ ${slot.toISOString()}`); continue; }
    const created = await createOutreachDraft(user, {
      prospectId: r.prospectId, channel: r.channel, contactId: r.contactId ?? undefined,
      subject, body: r.body,
    });
    if (!created.ok) { console.error(`FAIL create ${r.businessName}: ${created.error.message}`); continue; }
    const approved = await approveOutreachDraft(user, { draftId: created.data.draftId });
    if (!approved.ok) { console.error(`FAIL approve ${r.businessName}: ${approved.error.message}`); continue; }
    const sched = await scheduleDraftSend(user, { draftId: created.data.draftId, sendAt: slot, businessPurpose: PURPOSE });
    if (!sched.ok) { console.error(`FAIL schedule ${r.businessName}: ${sched.error.message}`); continue; }
    console.log(`fixed: ${r.businessName} → "${subject}" @ ${slot.toISOString()}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
