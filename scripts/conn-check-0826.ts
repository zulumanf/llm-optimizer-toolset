/** One-off (2026-08-26): list connector connections to find the Gmail row. */
import "dotenv/config";
import { sql } from "@/db/client";

async function main() {
  const rows = (await sql`
    select id, provider, project_id, status, created_at
    from connector_connections
    order by created_at desc
    limit 20
  `) as Record<string, unknown>[];
  for (const r of rows) console.log(JSON.stringify(r));
}

main().then(() => process.exit(0));
