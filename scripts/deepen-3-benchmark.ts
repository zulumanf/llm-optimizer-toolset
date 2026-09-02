/** Deepen pass: seed 4 city pipelines directly at 'benchmarking' (discovery
 * + review already done manually 2026-08-26) so the deployed worker runs
 * fresh benchmarks including the 23 new prospects, then links/scores/stages
 * findings launch-wide. Budget $3/city (prior runs ~$0.85-1). */
import "dotenv/config";
import { sql } from "@/db/client";
async function main(): Promise<void> {
  const [u] = await sql`select id from users where email = 'zulumanf@gmail.com'`;
  const CITIES: [string, string, string][] = [
    ["Savannah", "Georgia", "%savannah%"], ["Charleston", "South Carolina", "%charleston%"],
    ["Annapolis", "Maryland", "%annapolis%"], ["Princeton", "New Jersey", "%princeton%"],
  ];
  for (const [city, state, like] of CITIES) {
    const [l] = await sql`select id from market_launches where name ilike ${like} and archived_at is null`;
    const [active] = await sql`select id, status from city_prospecting_pipelines
      where lower(city_name) = ${city.toLowerCase()} and status not in ('completed','failed','cancelled')`;
    if (active) { console.log(`${city}: active pipeline exists (${active.status}) — skipped`); continue; }
    const [row] = await sql`insert into city_prospecting_pipelines
      (city_name, state_name, status, params, launch_id, requested_by, log)
      values (${city}, ${state}, 'benchmarking',
        ${sql.json({ targetProspects: 8, budgetUsd: 3, segment: "luxury residential" } as never)},
        ${l!.id}, ${u!.id},
        ${sql.json([{ at: new Date().toISOString(), stage: "benchmarking", message: "Deepening pass 2026-08-26: discovery+review done manually (23 new prospects across 4 cities); pipeline seeded at benchmarking." }] as never)})
      returning id`;
    console.log(`${city}: pipeline ${(row!.id as string).slice(0, 8)} seeded at benchmarking`);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
