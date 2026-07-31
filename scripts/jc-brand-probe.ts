/**
 * Brand-association probe for JC Luxury Group.
 *
 * The first run answered "do assistants surface this team unprompted?" — no,
 * 0 of 40. It also showed SERHANT surfacing in 3 of 40, always hedged and
 * never tied to a named Jersey City team.
 *
 * This set tests the hypothesis that produced: **if you ask directly about
 * SERHANT in Jersey City, does JC Luxury come back?** If it does, the problem
 * is discovery phrasing. If it does not, the affiliation is genuinely absent
 * from the public record assistants read — which is a different, cheaper
 * problem to fix, and one their own website is the cause of.
 *
 * Branded prompts are included as a control: an assistant that cannot answer
 * "what is JC Luxury Group known for?" tells us the entity is unknown, not
 * merely unranked.
 */
import "dotenv/config";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import { createPromptSet, freezePromptSet } from "@/lib/prompts/set-service";
import { addPrompt } from "@/lib/prompts/prompt-service";
import { startRun } from "@/lib/runs/service";
import { executeRun } from "@/lib/runs/execute";

const PROJECT_ID = "99360782-ce9b-44f6-af9e-c3c6ab0e0d26";

/** category must be one of the pack's vocabulary: recommendation/problem/comparison/branded/how-to */
const PROMPTS: { text: string; category: string }[] = [
  // Does the brand carry to the team?
  { text: "Who are the best SERHANT agents in Jersey City?", category: "recommendation" },
  { text: "Does SERHANT have a Jersey City team?", category: "recommendation" },
  { text: "Which SERHANT team covers the Jersey City waterfront?", category: "recommendation" },
  { text: "Best SERHANT agent for luxury condos in Jersey City", category: "recommendation" },
  { text: "SERHANT agents in Hoboken and Jersey City", category: "recommendation" },
  { text: "Is SERHANT active in New Jersey real estate?", category: "recommendation" },
  // Control: is the entity known at all?
  { text: "What is JC Luxury Group known for?", category: "branded" },
  { text: "Is JC Luxury Group a good real estate team?", category: "branded" },
  { text: "JC Luxury Group Jersey City — who are they?", category: "branded" },
  // The one named individual their own site surfaces.
  { text: "Who is Alexander Calle in Jersey City real estate?", category: "branded" },
  // Category questions where a Jersey City specialist should win.
  { text: "Which real estate team specialises in Jersey City new development condos?", category: "recommendation" },
  { text: "Best luxury real estate team based in Jersey City", category: "recommendation" },
];

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

  const set = await createPromptSet(user, {
    projectId: PROJECT_ID,
    name: "SERHANT association probe",
    description:
      "Tests whether the SERHANT brand association surfaces JC Luxury when asked directly, and whether the team is known at all.",
  });
  if (!set.ok) throw new Error(`createPromptSet: ${set.error.message}`);

  for (const p of PROMPTS) {
    const added = await addPrompt(user, {
      setId: set.data.id,
      text: p.text,
      category: p.category,
    });
    if (!added.ok) throw new Error(`addPrompt "${p.text}": ${added.error.message}`);
  }

  const frozen = await freezePromptSet(user, { id: set.data.id });
  if (!frozen.ok) throw new Error(`freeze: ${frozen.error.message}`);
  const [version] = await sql`
    select id from prompt_set_versions
    where prompt_set_id = ${set.data.id} and version = ${frozen.data.version}
  `;

  const run = await startRun(user, {
    projectId: PROJECT_ID,
    promptSetVersionId: version!.id as string,
    label: "SERHANT association probe — 2026-07-30",
    providers: [{ provider: "openai", model: "gpt-5.4-mini-2026-03-17", repetitions: 1 }],
    budgetUsd: 1,
  });
  if (!run.ok) throw new Error(`startRun: ${run.error.message}`);
  console.log(`run ${run.data.id} — ${PROMPTS.length} prompts, calling live API…`);

  await executeRun(run.data.id);
  const [s] = await sql`
    select status, cost_usd,
      (select count(*) from responses x where x.run_id = r.id) as n,
      (select count(*) from responses x where x.run_id = r.id and x.error is not null) as errors
    from runs r where r.id = ${run.data.id}
  `;
  console.log(`status=${s!.status} responses=${s!.n} errors=${s!.errors} cost=$${Number(s!.costUsd ?? 0).toFixed(4)}`);
  console.log("RUN_ID", run.data.id);
  await sql.end();
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
  await sql.end();
});
