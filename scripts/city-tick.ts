/** Retry failed city pipelines (--retry) and drive ticks until all settle. */
import "dotenv/config";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import { advanceCityPipelines, retryCityProspecting } from "@/lib/prospects/city-pipeline";
async function main() {
  const [u] = await sql`select id, email, name, role from users where email = 'zulumanf@gmail.com'`;
  if (!u) throw new Error("operator not found");
  const user = { id: u.id, email: u.email, name: u.name, role: u.role } as CurrentUser;
  if (process.argv.includes("--retry")) {
    const failed = await sql`select id, city_name from city_prospecting_pipelines
      where status = 'failed' and created_at > now() - interval '48 hours'`;
    for (const f of failed) {
      if (process.argv.includes("--only-discovery")) {
        const [r] = await sql`select failed_from_status from city_prospecting_pipelines where id = ${f.id}`;
        if (r?.failedFromStatus !== "discovering") { console.log(`skip retry (${r?.failedFromStatus}): ${f.cityName}`); continue; }
      }
      const res = await retryCityProspecting(user, { pipelineId: f.id });
      console.log(`retry ${f.cityName}: ${res.ok ? "resumed" : res.error.message}`);
    }
  }
  let last = "";
  for (let i = 0; i < 60; i++) {
    await advanceCityPipelines();
    const rows = await sql`select city_name, status, failed_from_status from city_prospecting_pipelines
      where created_at > now() - interval '48 hours' order by city_name`;
    const sig = rows.map((r) => `${r.cityName}=${r.status}${r.failedFromStatus ? `(${r.failedFromStatus})` : ""}`).join(" | ");
    if (sig !== last) { console.log(sig); last = sig; }
    if (rows.every((r) => ["completed", "failed", "cancelled"].includes(r.status as string))) break;
    await new Promise((r) => setTimeout(r, 20000));
  }
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
