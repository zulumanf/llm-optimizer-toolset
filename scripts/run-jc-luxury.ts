/**
 * First real measurement for JC Luxury Group (jcluxury.com).
 *
 * A prospect audit, not a baseline: one provider, one repetition, the frozen
 * 40-prompt set the vertical pack generated. The question it answers is blunt
 * and worth money to a prospect — when someone asks an AI assistant for a
 * Jersey City agent, does this firm appear at all, and who appears instead?
 *
 * Run with: npx tsx scripts/run-jc-luxury.ts
 */
import "dotenv/config";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import { freezePromptSet } from "@/lib/prompts/set-service";
import { startRun } from "@/lib/runs/service";
import { executeRun } from "@/lib/runs/execute";

const PROJECT_ID = "99360782-ce9b-44f6-af9e-c3c6ab0e0d26";
const PROMPT_SET_ID = "df463b75-563f-4ade-899f-fd2fc8262ca3";

async function main(): Promise<void> {
  const [row] = await sql`
    select id, email, name, role from users where email = 'zulumanf@gmail.com'
  `;
  const user: CurrentUser = {
    id: row!.id as string,
    email: row!.email as string,
    name: row!.name as string,
    role: row!.role as CurrentUser["role"],
  };

  const frozen = await freezePromptSet(user, { id: PROMPT_SET_ID });
  if (!frozen.ok) throw new Error(`freeze failed: ${frozen.error.message}`);
  console.log(`frozen set ${frozen.data.setId} at version ${frozen.data.version}`);

  const [version] = await sql`
    select id, jsonb_array_length(frozen_prompts) as n
    from prompt_set_versions
    where prompt_set_id = ${PROMPT_SET_ID} and version = ${frozen.data.version}
  `;
  console.log(`version ${version!.id} — ${version!.n} prompts`);

  const run = await startRun(user, {
    projectId: PROJECT_ID,
    promptSetVersionId: version!.id as string,
    label: "Prospect audit — 2026-07-30",
    providers: [
      { provider: "openai", model: "gpt-5.4-mini-2026-03-17", repetitions: 1 },
    ],
    // Hard ceiling. The earlier real run cost $0.04 for 18 responses, so this
    // should land near $0.10; the cap is what makes "should" safe to say.
    budgetUsd: 2,
  });
  if (!run.ok) throw new Error(`startRun failed: ${run.error.message}`);
  console.log(`run ${run.data.id} — calling the live API…`);

  await executeRun(run.data.id);

  const [summary] = await sql`
    select r.status, r.cost_usd,
      (select count(*) from responses x where x.run_id = r.id) as responses,
      (select count(*) from responses x where x.run_id = r.id and x.error is not null) as errors
    from runs r where r.id = ${run.data.id}
  `;
  console.log("status:", summary!.status);
  console.log("responses:", summary!.responses, "errors:", summary!.errors);
  console.log("cost: $", Number(summary!.costUsd ?? 0).toFixed(4));
  console.log("run id:", run.data.id);
  await sql.end();
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
  await sql.end();
});
