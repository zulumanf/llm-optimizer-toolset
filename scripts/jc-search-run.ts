/**
 * Search-enabled re-run for JC Luxury Group.
 *
 * The first audit used the non-search model, which answers from parametric
 * memory: 0 of 40 responses carried a URL, so we learned they are invisible
 * but not WHERE to intervene. The +search variant runs the Responses API with
 * the web_search tool and returns url_citation annotations — the pages an
 * assistant actually reads before recommending a Jersey City agent.
 *
 * Same frozen prompt-set version as the discovery run, so the two are directly
 * comparable: same questions, different instrument (docs/07 — a search-enabled
 * run is a DIFFERENT instrument, hence a distinct model id).
 */
import "dotenv/config";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import { startRun } from "@/lib/runs/service";
import { executeRun } from "@/lib/runs/execute";

const PROJECT_ID = "99360782-ce9b-44f6-af9e-c3c6ab0e0d26";
const VERSION_ID = "fe5939ac-3798-43a0-aa70-4fc97147eb75"; // the 40-prompt v1

async function main() {
  const [row] = await sql`select id,email,name,role from users where email='zulumanf@gmail.com'`;
  const user: CurrentUser = {
    id: row!.id as string, email: row!.email as string,
    name: row!.name as string, role: row!.role as CurrentUser["role"],
  };
  const run = await startRun(user, {
    projectId: PROJECT_ID,
    promptSetVersionId: VERSION_ID,
    label: "Prospect audit — search-enabled — 2026-07-30",
    providers: [{ provider: "openai", model: "gpt-5.4-mini-2026-03-17+search", repetitions: 1 }],
    budgetUsd: 3,
  });
  if (!run.ok) throw new Error(run.error.message);
  console.log("RUN", run.data.id);
  await executeRun(run.data.id);
  const [s] = await sql`
    select status, cost_usd,
      (select count(*) from responses x where x.run_id=r.id) as n,
      (select count(*) from responses x where x.run_id=r.id and x.error is not null) as err,
      (select count(*) from responses x where x.run_id=r.id and x.response_text ~ 'https?://') as with_url
    from runs r where r.id=${run.data.id}`;
  console.log(`status=${s!.status} n=${s!.n} errors=${s!.err} with_url=${s!.withUrl} cost=$${Number(s!.costUsd??0).toFixed(4)}`);
  console.log("RUN_ID", run.data.id);
  await sql.end();
}
main().catch(async (e) => { console.error(e.message); await sql.end(); });
