/** Run the audit sense-check for every JC prospect with a pending scheduled send
 *  and print concern-severity items. Read-mostly (stores the check row).
 *  npx tsx scripts/jc-batch2-sense.ts */
import "dotenv/config";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import { runSenseCheck } from "@/lib/prospects/sense-check";

async function main(): Promise<void> {
  const [u] = await sql`select id, email, name, role from users where email = 'zulumanf@gmail.com'`;
  if (!u) throw new Error("operator user not found");
  const user: CurrentUser = { id: u.id as string, email: u.email as string, name: u.name as string, role: u.role as CurrentUser["role"] };
  const rows = await sql`
    select distinct p.id, p.business_name from outreach_drafts d join prospects p on p.id = d.prospect_id
    where d.status = 'approved' and d.sent_recorded_at is null order by p.business_name`;
  for (const r of rows) {
    const sc = await runSenseCheck(user, { prospectId: r.id });
    if (!sc.ok) { console.error(`${r.businessName}: error — ${sc.error.message}`); continue; }
    if (sc.data.error) { console.error(`${r.businessName}: FAILED — ${sc.data.error}`); continue; }
    const concerns = sc.data.concerns.filter((c) => c.severity === "concern");
    console.log(`${r.businessName}: ${sc.data.concerns.length} item(s), ${concerns.length} concern(s)`);
    for (const c of concerns) console.log(`  · [${c.area}] ${c.detail}`);
  }
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
