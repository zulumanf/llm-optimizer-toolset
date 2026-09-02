/** QA: stored followup drafts vs jc-followup-drafts.json — body match, contact, status. */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { sql } from "@/db/client";
const rows = JSON.parse(readFileSync("scripts/jc-followup-drafts.json", "utf8"));
async function main() {
  let ok = 0;
  for (const d of rows) {
    const [r] = await sql`
      select p.business_name, d2.subject, d2.body, d2.status, c.email, c.name
      from outreach_drafts d2
      join prospects p on p.id = d2.prospect_id
      left join prospect_contacts c on c.id = d2.contact_id
      where p.id::text like ${d.prospectIdPrefix + "%"} and d2.channel = 'followup_email'
        and d2.sent_recorded_at is null
      order by d2.version desc limit 1`;
    if (!r) { console.log(`MISSING: ${d.business}`); continue; }
    const bodyOk = r.body === d.body;
    const subjOk = r.subject === d.subject;
    if (bodyOk && subjOk && r.status === "approved" && r.email) ok += 1;
    else console.log(`MISMATCH ${d.business}: body=${bodyOk} subj=${subjOk} status=${r.status} email=${r.email}`);
    console.log(`${r.businessName} → ${r.name} <${r.email}> [${r.status}] body=${bodyOk ? "exact" : "DIFF"}`);
  }
  console.log(`\n${ok}/${rows.length} verified exact + approved + contact-bound`);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
