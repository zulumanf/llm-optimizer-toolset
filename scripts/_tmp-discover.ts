import "dotenv/config";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import { runExternalDiscovery } from "@/lib/knowledge/discovery/service";
import { microToUsd } from "@/lib/ai/pricing";

async function main(): Promise<void> {
  const [u] = await sql`select id,email,name,role from users where email='zulumanf@gmail.com'`;
  const user: CurrentUser = {
    id: u!.id as string, email: u!.email as string,
    name: u!.name as string, role: u!.role as CurrentUser["role"],
  };
  const [p] = await sql`select id from projects where name ilike '%JC Luxury%'`;

  const res = await runExternalDiscovery(user, {
    projectId: p!.id,
    markets: ["Jersey City", "Hoboken"],
    affiliation: "SERHANT",
    maxPages: 5,
    costCapMicroUsd: 1_500_000,
  });

  if (!res.ok) { console.error("FAILED:", res.error.message); process.exit(1); }
  const d = res.data;
  console.log("\n──────── DISCOVERY RESULT ────────");
  console.log("status:      ", d.status);
  console.log("queries:     ", d.queries.length);
  for (const q of d.queries) console.log("   ", q.template.padEnd(18), q.text);
  console.log("found:       ", d.candidatesFound);
  console.log("ingested:    ", d.candidatesIngested);
  console.log("skipped:     ", JSON.stringify(d.skipped));
  console.log("claims:      ", d.claimsProposed);
  console.log("contradictions:", d.contradictionsRaised);
  console.log("cost:        ", `$${microToUsd(d.costMicroUsd).toFixed(4)} (token cost only)`);
  console.log("\n", d.narrative, "\n");
  await sql.end();
}
main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
