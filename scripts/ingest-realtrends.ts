/**
 * Spec 124 — ingest structured RealTrends production records so the
 * competitive-mismatch template has verified evidence to compare
 * (competitor teams are ingested as the peer prospects they already are).
 *
 * Usage: npx tsx scripts/ingest-realtrends.ts <records.json>
 * where records.json is [{ "prospectId": "...", "record": RealTrendsRecord }, ...]
 * (RealTrendsRecord shape: lib/prospects/realtrends.ts — rankScope and
 * productionYear are what make the record comparable; capturedOn is the
 * date the operator verified the source page.)
 *
 * Idempotent: ingestRealTrendsRecord dedupes on kind + source URL + scope +
 * value, so re-running a file never inflates the evidence base.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import {
  ingestRealTrendsRecord,
  type RealTrendsRecord,
} from "@/lib/prospects/realtrends";

/** Scripts act as the operator on record (the city-prep.ts pattern). */
async function operatorUser(): Promise<CurrentUser> {
  const [u] = await sql`
    select id, email, name, role from users where email = 'zulumanf@gmail.com'
  `;
  if (!u) throw new Error("Operator user not found.");
  return {
    id: u.id as string,
    email: u.email as string,
    name: u.name as string,
    role: u.role as CurrentUser["role"],
  };
}

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: npx tsx scripts/ingest-realtrends.ts <records.json>");
    process.exit(1);
  }
  const entries = JSON.parse(readFileSync(file, "utf8")) as {
    prospectId: string;
    record: RealTrendsRecord;
  }[];
  const user = await operatorUser();
  let inserted = 0;
  let skipped = 0;
  for (const entry of entries) {
    const result = await ingestRealTrendsRecord(user, entry);
    if (!result.ok) {
      console.error(`FAILED ${entry.prospectId}: ${result.error.message}`);
      continue;
    }
    inserted += result.data.inserted;
    skipped += result.data.skippedDuplicates;
    console.log(
      `${entry.prospectId}: +${result.data.inserted} signals (${result.data.skippedDuplicates} duplicates skipped)`
    );
  }
  console.log(`\nDone. Inserted ${inserted}, skipped ${skipped} duplicates.`);
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
