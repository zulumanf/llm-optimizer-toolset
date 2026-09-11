/**
 * Spec 117 §5 — weekly spend reconciliation. Prints our tracked spend per
 * day (token cost incl. per-call fees) split by provider/model family, to
 * set against the OpenAI/Perplexity billing dashboards. Drift between the
 * two IS the alarm that a pricing assumption rotted.
 *   npx tsx scripts/spend-reconcile.ts [days=7]
 */
import "dotenv/config";
import { sql } from "@/db/client";

async function main(): Promise<void> {
  const days = Number(process.argv[2] ?? 7);
  const rows = await sql`
    select date_trunc('day', requested_at)::date as day, provider,
      count(*)::int as calls,
      round(sum(cost_usd)::numeric, 2) as tracked_usd,
      count(*) filter (where model like '%+search')::int as search_calls
    from responses
    where requested_at > now() - make_interval(days => ${days}) and error is null
    group by 1, 2 order by 1 desc, 2`;
  console.log("day        | provider   | calls | tracked$ | search calls (per-call fee now included in tracked$ for new rows)");
  for (const r of rows)
    console.log(`${r.day} | ${String(r.provider).padEnd(10)} | ${String(r.calls).padStart(5)} | ${String(r.trackedUsd).padStart(8)} | ${r.searchCalls}`);
  console.log("\nCompare each day against the provider billing dashboard. Rows captured before spec 117 exclude the search fee — add ~$0.01 × search calls for those days.");
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
