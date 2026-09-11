/** Deepen existing cities (operator 2026-08-26): perplexity discovery pass on the 4 city launches. */
import "dotenv/config";
import { sql } from "@/db/client";
import { runProspectDiscovery } from "@/lib/prospects/discovery";
import type { CurrentUser } from "@/lib/auth";
async function main(): Promise<void> {
  const [u] = await sql`select id, email, name, role from users where email = 'zulumanf@gmail.com'`;
  const user = u as unknown as CurrentUser;
  const launches = await sql`select id, name from market_launches where archived_at is null
    and (name ilike '%savannah%' or name ilike '%charleston%' or name ilike '%annapolis%' or name ilike '%princeton%')`;
  for (const l of launches) {
    const r = await runProspectDiscovery(user, { launchId: l.id, provider: "perplexity", limit: 15 });
    console.log(l.name, r.ok ? `+${r.data.candidateCount} candidates` : `FAIL: ${r.error.message}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
