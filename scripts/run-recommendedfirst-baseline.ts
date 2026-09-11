/**
 * RecommendedFirst dogfood baseline (spec 089): the first scored run against
 * the frozen prompt universe. Mirrors the house weekly-baseline methodology
 * (openai mini + search, perplexity sonar, 4 repetitions each) so later
 * snapshots are directly comparable, then enrolls the project in the weekly
 * baseline with the same configuration.
 *
 * Safe to re-run: a completed run is never mutated — re-running creates a
 * NEW run (docs/07), and the /dogfood baseline stays the earliest scored run.
 *
 * Run with: npx tsx scripts/run-recommendedfirst-baseline.ts
 */
import "dotenv/config";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import { startRun } from "@/lib/runs/service";
import { executeRun } from "@/lib/runs/execute";
import { updateBaselineSettings } from "@/lib/projects/baseline";

const PROVIDERS = [
  { provider: "openai" as const, model: "gpt-5.4-mini-2026-03-17+search", repetitions: 4 },
  { provider: "perplexity" as const, model: "sonar", repetitions: 4 },
];
const BUDGET_USD = 10;

async function main(): Promise<void> {
  const [row] = await sql`
    select id, email, name, role from users where email = 'zulumanf@gmail.com'
  `;
  if (!row) throw new Error("Operator user not found.");
  const user: CurrentUser = {
    id: row.id as string,
    email: row.email as string,
    name: row.name as string,
    role: row.role as CurrentUser["role"],
  };

  const [project] = await sql`
    select id from projects where kind = 'internal' and status = 'active'
    order by created_at asc limit 1
  `;
  if (!project) throw new Error("No internal project — run onboard-recommendedfirst first.");
  const projectId = project.id as string;

  const [version] = await sql`
    select v.id, v.prompt_set_id, jsonb_array_length(v.frozen_prompts) as n
    from prompt_set_versions v
    join prompt_sets s on s.id = v.prompt_set_id
    where s.project_id = ${projectId} and s.archived_at is null
    order by v.frozen_at desc limit 1
  `;
  if (!version) throw new Error("No frozen prompt set version found.");
  console.log(`frozen version ${version.id} — ${version.n} prompts`);

  const run = await startRun(user, {
    projectId,
    promptSetVersionId: version.id as string,
    label: `Dogfood snapshot — ${new Date().toISOString().slice(0, 10)}`,
    providers: PROVIDERS,
    budgetUsd: BUDGET_USD,
  });
  if (!run.ok) throw new Error(`startRun failed: ${run.error.message}`);
  console.log(`run ${run.data.id} — calling the live APIs…`);

  await executeRun(run.data.id);

  const [summary] = await sql`
    select r.status, r.cost_usd,
      (select count(*) from responses x where x.run_id = r.id) as responses,
      (select count(*) from responses x where x.run_id = r.id and x.error is not null) as errors
    from runs r where r.id = ${run.data.id}
  `;
  console.log("status:   ", summary!.status);
  console.log("responses:", summary!.responses, "errors:", summary!.errors);
  console.log("cost: $   ", Number(summary!.costUsd ?? 0).toFixed(4));

  const enrolled = await updateBaselineSettings(user, {
    projectId,
    baselinePromptSetId: version.promptSetId as string,
    providers: PROVIDERS,
    budgetUsd: BUDGET_USD,
  });
  console.log(
    enrolled.ok
      ? "weekly baseline enrolled with the same providers/budget"
      : `weekly enrollment failed (non-fatal): ${enrolled.error.message}`
  );
  console.log("dashboard: /dogfood");
  await sql.end();
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
  await sql.end();
});
