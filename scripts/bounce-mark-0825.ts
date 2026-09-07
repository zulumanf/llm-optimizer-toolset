/** Mark the 2026-08-25 hard-bounced contacts do-not-contact and cancel any
 *  still-pending scheduled sends to them. One-off remediation ahead of spec 118. */
import "dotenv/config";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import { cancelScheduledSend } from "@/lib/prospects/service";

const BOUNCED: Record<string, string> = {
  "patrick@southern.properties":
    "hard_bounce 2026-08-25: domain southern.properties does not exist (Perplexity-fabricated). Real address per cited Serhant page: southern@serhant.com — confirm in browser before use.",
  "dale.fior@bhsusa.com":
    "hard_bounce 2026-08-25: mailbox not found (likely pattern-guessed by Perplexity; bhsusa.com blocks bots, unverified). Re-source before contacting.",
  "info@kghometeam.com":
    "hard_bounce 2026-08-25: Google Group rejects external senders. Address is correct per kghometeam.com/contact-us but unreachable — find alternate channel.",
};

async function main(): Promise<void> {
  const [u] = await sql`select id, email, name, role from users where email = 'zulumanf@gmail.com'`;
  if (!u) throw new Error("operator user not found");
  const user: CurrentUser = { id: u.id as string, email: u.email as string, name: u.name as string, role: u.role as CurrentUser["role"] };

  for (const [email, reason] of Object.entries(BOUNCED)) {
    const updated = (await sql`
      update prospect_contacts set do_not_contact = true, do_not_contact_reason = ${reason}, updated_at = now()
      where lower(email) = ${email} and archived_at is null
      returning id, prospect_id
    `) as { id: string; prospectId: string }[];
    console.log(`DNC ${email}: ${updated.length} contact(s) marked`);

    for (const c of updated) {
      const pending = (await sql`
        select id, status, scheduled_send_at from outreach_drafts
        where contact_id = ${c.id} and sent_recorded_at is null
          and status not in ('cancelled', 'rejected')
      `) as { id: string; status: string; scheduledSendAt: Date | null }[];
      for (const d of pending) {
        if (d.scheduledSendAt) {
          const res = await cancelScheduledSend(user, { draftId: d.id });
          console.log(res.ok ? `  cancelled scheduled draft ${d.id}` : `  FAILED cancel ${d.id}: ${res.error.message}`);
        } else {
          console.log(`  pending unscheduled draft ${d.id} (status=${d.status}) — left as-is, DNC now blocks it`);
        }
      }
      if (pending.length === 0) console.log(`  no pending drafts`);
    }
  }
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
