/** Regenerate Wilmington findings under the count-exact absence title and
 * re-approve the fresh absence candidate as primary. One line per prospect. */
import "dotenv/config";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import { generateFindings, reviewFinding } from "@/lib/prospects/service";
const SKIP = new Set(["Gillespie Group Real Estate Team", "Rakan Abuzahra", "Christopher Levy Group", "Ken Van Every", "Michael Aldridge"]);
async function main() {
  const [u] = await sql`select id, email, name, role from users where email = 'zulumanf@gmail.com'`;
  if (!u) throw new Error("operator not found");
  const user = { id: u.id, email: u.email, name: u.name, role: u.role } as CurrentUser;
  const rows = await sql`
    select p.id, p.business_name, f.benchmark_id
    from prospects p
    join market_launches l on l.id = p.launch_id
    join prospect_findings f on f.prospect_id = p.id and f.is_primary and f.status = 'approved'
    where l.id::text like 'c0bd8d88%' and p.archived_at is null and p.do_not_contact = false
    order by p.business_name`;
  for (const r of rows) {
    if (SKIP.has(r.businessName as string)) continue;
    const gen = await generateFindings(user, { benchmarkId: r.benchmarkId });
    if (!gen.ok) { console.error(`FAILED gen ${r.businessName}: ${gen.error.message}`); continue; }
    const [cand] = await sql`
      select id, title from prospect_findings
      where prospect_id = ${r.id} and status = 'candidate' and kind = 'absence'
      order by created_at desc limit 1`;
    if (!cand) { console.error(`no absence candidate: ${r.businessName}`); continue; }
    const rev = await reviewFinding(user, { findingId: cand.id, decision: "approved", makePrimary: true });
    console.log(rev.ok ? `${r.businessName}: ${cand.title}` : `FAILED approve ${r.businessName}: ${rev.error.message}`);
  }
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
