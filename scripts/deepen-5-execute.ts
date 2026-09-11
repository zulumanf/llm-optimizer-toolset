/** Execute tonight's 4 deepening benchmark runs serially (parallel trips OpenAI rate limits; executeRun resumes captured cells). */
import "dotenv/config";
import { executeRun } from "@/lib/runs/execute";
import { sql } from "@/db/client";
async function main() {
  const runs = await sql`select p.run_id, l.name from city_prospecting_pipelines p join market_launches l on l.id=p.launch_id
    where p.created_at > now() - interval '12 hours' and p.run_id is not null order by l.name`;
  for (const r of runs) {
    console.log(`executing ${r.name}...`);
    try { await executeRun(r.runId as string); } catch (e) { console.error(`${r.name}: ${(e as Error).message.slice(0, 120)}`); }
    const [f] = await sql`select status, cost_usd from runs where id = ${r.runId}`;
    console.log(`${r.name}: ${f?.status} $${f?.costUsd}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
