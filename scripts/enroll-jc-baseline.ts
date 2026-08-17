/**
 * One-off enrollment: put the shared Jersey City prospect benchmark project
 * ("Prospect benchmark: Properties by Southern — Jersey City") on the weekly
 * baseline, so Monday's cron keeps the measurement data behind all Jersey
 * City prospect audits fresh (operator-approved 2026-08-16; publishing stays
 * human-gated per PRINCIPLES #8).
 *
 * Reuses the providers and budget of the project's most recent finished run —
 * the configuration that produced the published audits — and goes through
 * updateBaselineSettings, so prompt-set/frozen-version validation and the
 * audit log apply exactly as they would from the settings UI.
 *
 * Run with:  npx tsx scripts/enroll-jc-baseline.ts          (dry run)
 *            APPLY=1 npx tsx scripts/enroll-jc-baseline.ts  (enroll)
 */
import "dotenv/config";
import { sql } from "@/db/client";
import { updateBaselineSettings } from "@/lib/projects/baseline";
import type { CurrentUser } from "@/lib/auth";
import type { ProviderConfig } from "@/lib/runs/cells";

/** Shared market benchmark whose runs feed the published JC audits (spec 054). */
const PROJECT_ID = "226081c3-adf8-4c0d-8293-3866682ac6a5";

async function main(): Promise<void> {
  const [operator] = await sql`
    select id, email, name, role from users where email = 'zulumanf@gmail.com'
  `;
  if (!operator) throw new Error("Operator user not found.");
  const user: CurrentUser = {
    id: operator.id as string,
    email: operator.email as string,
    name: operator.name as string,
    role: operator.role as CurrentUser["role"],
  };

  const [project] = await sql`
    select name, status, baseline_prompt_set_id from projects where id = ${PROJECT_ID}
  `;
  if (!project) throw new Error("Project not found.");
  console.log(`Project: ${project.name} (status=${project.status})`);
  if (project.baselinePromptSetId) {
    console.log("Already enrolled — baseline_prompt_set_id is set. Nothing to do.");
    return;
  }

  // The audits' own run is the template: same prompt set, providers, budget.
  const [run] = await sql`
    select r.id, r.label, r.providers, r.budget_usd, r.cost_usd, r.status,
      v.prompt_set_id, s.name as set_name
    from runs r
      join prompt_set_versions v on v.id = r.prompt_set_version_id
      join prompt_sets s on s.id = v.prompt_set_id
    where r.project_id = ${PROJECT_ID}
      and r.status in ('completed', 'partial')
    order by r.started_at desc limit 1
  `;
  if (!run) throw new Error("No finished run on the project to copy.");

  const providers = run.providers as ProviderConfig[];
  const budgetUsd = Number(run.budgetUsd);
  console.log(`Template run: "${run.label}" (${run.status}, cost $${run.costUsd})`);
  console.log(`Prompt set:   ${run.setName} (${run.promptSetId})`);
  console.log(`Providers:    ${providers.map((p) => `${p.provider}/${p.model}`).join(", ")}`);
  console.log(`Budget cap:   $${budgetUsd}/week (actual last-run cost: $${run.costUsd})`);

  if (process.env.APPLY !== "1") {
    console.log("\nDry run — set APPLY=1 to enroll.");
    return;
  }

  const result = await updateBaselineSettings(user, {
    projectId: PROJECT_ID,
    baselinePromptSetId: run.promptSetId as string,
    providers,
    budgetUsd,
  });
  if (!result.ok) throw new Error(`Enrollment failed: ${result.error.message}`);
  console.log("\nEnrolled — Monday's weekly cycle will start this project's run.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
