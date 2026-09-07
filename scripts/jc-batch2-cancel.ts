/** Cancel scheduled sends for named JC prospects (batch 2 triage). Usage:
 *  npx tsx scripts/jc-batch2-cancel.ts "The Mumoli Collective" ["The Pinto Group" ...] */
import "dotenv/config";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import { cancelScheduledSend } from "@/lib/prospects/service";

async function main(): Promise<void> {
  const names = process.argv.slice(2);
  if (names.length === 0) throw new Error("pass at least one business name");
  const [u] = await sql`select id, email, name, role from users where email = 'zulumanf@gmail.com'`;
  if (!u) throw new Error("operator user not found");
  const user: CurrentUser = { id: u.id as string, email: u.email as string, name: u.name as string, role: u.role as CurrentUser["role"] };
  for (const name of names) {
    const [d] = await sql`
      select d.id, d.scheduled_send_at from outreach_drafts d join prospects p on p.id = d.prospect_id
      where p.business_name = ${name} and d.scheduled_send_at is not null and d.sent_recorded_at is null`;
    if (!d) { console.log(`nothing scheduled: ${name}`); continue; }
    const res = await cancelScheduledSend(user, { draftId: d.id });
    console.log(res.ok ? `cancelled: ${name} (was ${new Date(d.scheduledSendAt as Date).toISOString()})` : `FAILED: ${name} — ${res.error.message}`);
  }
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
