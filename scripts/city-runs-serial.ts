/** Execute the 4 city benchmark runs ONE AT A TIME (parallel 512-cell runs
 * tripped OpenAI's rate limiter and were classified quota-exhausted).
 * executeRun resumes: captured cells are never re-bought. */
import "dotenv/config";
import { executeRun } from "@/lib/runs/execute";
import { sql } from "@/db/client";
const RUNS: [string, string][] = [
  ["Savannah", "965834e3"], ["Charleston", "56d332e8"],
  ["Annapolis", "40719c6d"], ["Princeton", "38617a0c"],
];
async function main() {
  for (const [city, prefix] of RUNS) {
    const [r] = await sql`select id from runs where id::text like ${prefix + "%"}`;
    if (!r) { console.error(`run not found: ${city}`); continue; }
    await executeRun(r.id as string);
    const [f] = await sql`select status, status_detail, cost_usd from runs where id = ${r.id}`;
    if (!f) continue;
    console.log(`${city}: ${f.status} ${f.statusDetail ?? ""} ($${f.costUsd})`);
  }
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
