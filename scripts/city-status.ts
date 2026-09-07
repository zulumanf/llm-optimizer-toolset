import "dotenv/config";
import { sql } from "@/db/client";
async function main() {
  const r = await sql`select city_name, status, error from city_prospecting_pipelines where created_at > now() - interval '12 hours' order by city_name`;
  console.log(r.map((x) => `${x.cityName}=${x.status}${x.error ? " ERR:" + String(x.error).slice(0, 100) : ""}`).join(" | "));
  const runs = await sql`select l.name, r.status, r.cost_usd, (select count(*)::int from scores s where s.run_id=r.id) sc
    from city_prospecting_pipelines p join runs r on r.id=p.run_id join market_launches l on l.id=p.launch_id
    where p.created_at > now() - interval '12 hours' order by l.name`;
  for (const x of runs) console.log(`run ${x.name}: ${x.status} $${x.costUsd} scores=${x.sc}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
