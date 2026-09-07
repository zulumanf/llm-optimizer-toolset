/**
 * Campaign week 2026-09-08: record web-agent-discovered contacts ONLY after
 * this process itself fetches the cited public page and finds the literal
 * address on it (lib/prospects/contact-verify). Discovery proposes;
 * verification decides. Verified rows become the primary contact with
 * provenance `publicly_sourced` and the proof URL in notes; everything else
 * is printed as DISCOVERED_UNVERIFIED and never recorded.
 *
 * Run: npx tsx scripts/campaign-0908-add-contacts.ts <candidates.json> [--dry]
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import { emailOnPage } from "@/lib/prospects/contact-verify";
import { addContact, updateProspect } from "@/lib/prospects/service";

interface Candidate { business: string; market: string; contactName: string; role: string | null; email: string; sourceUrl: string; generic: boolean }
const file = process.argv[2]!;
const dry = process.argv.includes("--dry");

async function main(): Promise<void> {
  const [u] = await sql`select id, email, name, role from users where email = 'zulumanf@gmail.com'`;
  const user = { id: u!.id, email: u!.email, name: u!.name, role: u!.role } as CurrentUser;
  const cands = JSON.parse(readFileSync(file, "utf8")) as Candidate[];
  let verified = 0, unverified = 0, skipped = 0;
  for (const c of cands) {
    const [p] = await sql`
      select p.id, p.business_name from prospects p join market_launches l on l.id = p.launch_id
      where p.business_name = ${c.business} and l.name like ${c.market + "%"} and p.archived_at is null`;
    if (!p) { console.log(`SKIP      ${c.business}: prospect not found in ${c.market}`); skipped += 1; continue; }
    const [existing] = await sql`select id from prospect_contacts where prospect_id = ${p.id} and email is not null and archived_at is null limit 1`;
    if (existing) { console.log(`SKIP      ${c.business}: already has an email contact`); skipped += 1; continue; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c.email)) { console.log(`SKIP      ${c.business}: malformed ${c.email}`); skipped += 1; continue; }
    const proof = emailOnPage(c.sourceUrl, c.email);
    if (!proof) { console.log(`UNVERIFIED ${c.business}: ${c.email} not literally on ${c.sourceUrl}`); unverified += 1; continue; }
    console.log(`VERIFIED  ${c.business}: ${c.email}${c.generic ? " (team inbox)" : ""} ← ${c.sourceUrl}`);
    verified += 1;
    if (dry) continue;
    const added = await addContact(user, {
      prospectId: p.id as string, name: c.contactName, role: c.role ?? undefined, email: c.email, isPrimary: true, provenance: "publicly_sourced",
      notes: `email source (web-agent discovered 2026-09-06, fetch-verified literally on page by scripts/campaign-0908-add-contacts.ts): ${c.sourceUrl}${c.generic ? " · team inbox, not a personal address" : ""}`,
    });
    if (!added.ok) { console.log(`  addContact FAILED: ${added.error.message}`); continue; }
    const up = await updateProspect(user, { prospectId: p.id as string, email: c.email, fieldProvenance: { email: "publicly_sourced" } });
    if (!up.ok) console.log(`  updateProspect FAILED: ${up.error.message}`);
  }
  console.log(`\nverified ${verified} · unverified ${unverified} · skipped ${skipped}${dry ? " (dry: nothing written)" : ""}`);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
