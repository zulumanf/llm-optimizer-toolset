/**
 * Systematic QA of the 2026-08-26 city batch: every approved, unscheduled
 * draft in the Savannah/Charleston/Annapolis launches. Failures only, then
 * a subjects/recipients table. (Spec-116 gate ran at approval; this re-runs
 * it plus batch-level checks in one sweep before scheduling.)
 */
import "dotenv/config";
import { sql } from "@/db/client";
import { qaDraft } from "@/lib/prospects/draft-qa";

const HOLD = new Set(["Housecats Company", "Jen Holden Group", "Team Spartina"]); // Compass caps / org cluster

async function main(): Promise<void> {
  const rows = await sql`
    select d.id, p.business_name, l.name as launch, d.subject, c.email as cemail, p.brokerage_affiliation
    from outreach_drafts d
    join prospects p on p.id = d.prospect_id
    join market_launches l on l.id = p.launch_id
    left join prospect_contacts c on c.id = d.contact_id
    where d.status = 'approved' and d.sent_recorded_at is null and d.scheduled_send_at is null
      and (l.name ilike '%savannah%' or l.name ilike '%charleston%' or l.name ilike '%annapolis%')
      and p.do_not_contact = false
    order by l.name, p.business_name`;
  const sendable = rows.filter((r) => !HOLD.has(r.businessName as string));
  let bad = 0;
  for (const r of sendable) {
    const issues = await qaDraft(r.id as string);
    if (issues.length) { bad++; console.log(`FAIL ${r.businessName}: ${issues.map((i) => `[${i.check}] ${i.detail}`).join(" ")}`); }
  }
  // brokerage concentration within the batch (3/30d cap counts at dispatch)
  const byBrokerage = new Map<string, number>();
  for (const r of sendable) {
    const b = ((r.brokerageAffiliation as string | null) ?? "").toLowerCase().trim();
    if (b) byBrokerage.set(b, (byBrokerage.get(b) ?? 0) + 1);
  }
  for (const [b, n] of byBrokerage) if (n > 3) console.log(`FAIL brokerage concentration: ${b} ×${n} (cap 3/30d)`);
  console.log(`${sendable.length} sendable drafts checked (${rows.length - sendable.length} held), ${bad} QA failures`);
  console.log("\n--- SUBJECTS / RECIPIENTS ---");
  for (const r of sendable) console.log(`[${(r.launch as string).slice(0, 12)}] ${r.cemail} | ${r.subject}`);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
