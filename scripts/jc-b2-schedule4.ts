/** Schedule EXACTLY the 4 cap-clear batch-2 first-touches (2026-08-25 plan).
 * The generic batch-2 scheduler would sweep in Compass/CB/eXp-blocked and
 * merit-cancelled drafts — this one is allowlisted.
 *   npx tsx scripts/jc-b2-schedule4.ts --schedule 2026-08-25T16:20:00Z --apply */
import "dotenv/config";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import { scheduleDraftSend } from "@/lib/prospects/service";
const NAMES = ["Ellason Curdgele", "Trompeter Real Estate"]; // Pinto+Farah = Compass, cap-held ~9/19
const STAGGER_MIN = 10;
const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const AT = argv.includes("--schedule") ? argv[argv.indexOf("--schedule") + 1] : null;
async function main() {
  if (!AT) throw new Error("--schedule <ISO> required");
  const [u] = await sql`select id, email, name, role from users where email = 'zulumanf@gmail.com'`;
  if (!u) throw new Error("operator not found");
  const user = { id: u.id, email: u.email, name: u.name, role: u.role } as CurrentUser;
  let slot = 0;
  for (const name of NAMES) {
    const [d] = await sql`
      select d.id, p.business_name from outreach_drafts d join prospects p on p.id = d.prospect_id
      where p.business_name = ${name} and d.status = 'approved' and d.sent_recorded_at is null
        and d.scheduled_send_at is null order by d.version desc limit 1`;
    if (!d) { console.error(`no approved-unscheduled draft: ${name}`); continue; }
    const at = new Date(new Date(AT).getTime() + slot * STAGGER_MIN * 60_000);
    slot += 1;
    if (!APPLY) { console.log(`would schedule: ${name} at ${at.toISOString()}`); continue; }
    const res = await scheduleDraftSend(user, {
      draftId: d.id, sendAt: at,
      businessPurpose: "JC batch 2 first-touch (cap-clear subset): published sense-checked audit, reply-first ask; contact publicly sourced.",
    });
    console.log(res.ok ? `scheduled: ${name} at ${res.data.sendAt}` : `FAILED ${name}: ${res.error.message}`);
  }
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
