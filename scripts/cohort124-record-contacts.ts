/**
 * Cohort-124 contact recorder (2026-08-31): apply web-verified decision-maker
 * contacts to prospects. Input JSON (array) at the path given by --file:
 *   { prospectId, name, role, email, sourceUrl, marketEvidence,
 *     marketEvidenceUrl, verified: boolean, notes? }
 * Only verified=true rows are recorded: addContact (primary,
 * provenance publicly_sourced, evidence URLs in notes) + prospect email.
 * Unverified rows are listed, never written. Nothing sends.
 *
 * Run: npx tsx scripts/cohort124-record-contacts.ts --file <path>
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import { addContact, updateProspect } from "@/lib/prospects/service";

interface Row {
  prospectId: string;
  name: string;
  role: string | null;
  email: string | null;
  sourceUrl: string | null;
  marketEvidence: string | null;
  marketEvidenceUrl: string | null;
  verified: boolean;
  notes?: string;
}

async function main(): Promise<void> {
  const i = process.argv.indexOf("--file");
  if (i < 0) throw new Error("--file required");
  const rows = JSON.parse(readFileSync(process.argv[i + 1]!, "utf8")) as Row[];
  const [u] = await sql`select id, email, name, role from users where email = 'zulumanf@gmail.com'`;
  const user = { id: u!.id, email: u!.email, name: u!.name, role: u!.role } as CurrentUser;
  let recorded = 0;
  let skipped = 0;
  for (const r of rows) {
    if (!r.verified || !r.email || !r.sourceUrl) {
      skipped += 1;
      console.log(`SKIP (unverified) ${r.name} — ${r.notes ?? "no verified email"}`);
      continue;
    }
    const notes = [
      `email source: ${r.sourceUrl}`,
      r.marketEvidence ? `market relevance: ${r.marketEvidence}` : null,
      r.marketEvidenceUrl ? `market evidence: ${r.marketEvidenceUrl}` : null,
      r.notes ?? null,
    ]
      .filter(Boolean)
      .join("\n");
    const res = await addContact(user, {
      prospectId: r.prospectId,
      name: r.name,
      role: r.role ?? undefined,
      email: r.email,
      isPrimary: true,
      provenance: "publicly_sourced",
      notes,
    });
    if (!res.ok) {
      console.log(`FAILED ${r.name}: ${res.error.message}`);
      continue;
    }
    await updateProspect(user, {
      prospectId: r.prospectId,
      email: r.email,
      fieldProvenance: { email: "publicly_sourced" },
    });
    recorded += 1;
  }
  console.log(`recorded ${recorded}, skipped ${skipped}, total ${rows.length}`);
  await sql.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
