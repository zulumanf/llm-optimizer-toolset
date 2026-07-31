/**
 * Gemini comparison for JC Luxury Group.
 *
 * Runs the SAME frozen 40-prompt version as the OpenAI no-search run
 * (af764e98), so the two are directly comparable: identical questions,
 * identical scoring version, different provider.
 *
 * Compared against the NO-SEARCH OpenAI run on purpose. lib/ai/google.ts calls
 * generateContent without search grounding, so pitting it against the +search
 * run would compare two different instruments and call the difference a
 * provider effect.
 */
import "dotenv/config";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import { startRun } from "@/lib/runs/service";
import { executeRun } from "@/lib/runs/execute";

const PROJECT = "99360782-ce9b-44f6-af9e-c3c6ab0e0d26";
const VERSION_ID = "fe5939ac-3798-43a0-aa70-4fc97147eb75";

async function main() {
  const [u] = await sql`select id,email,name,role from users where email='zulumanf@gmail.com'`;
  const user: CurrentUser = { id: u!.id as string, email: u!.email as string, name: u!.name as string, role: u!.role as CurrentUser["role"] };
  const run = await startRun(user, {
    projectId: PROJECT,
    promptSetVersionId: VERSION_ID,
    label: "Prospect audit — Gemini 2.5 Flash — 2026-07-30",
    providers: [{ provider: "google", model: "gemini-3-flash-preview", repetitions: 1 }],
    budgetUsd: 2,
  });
  if (!run.ok) throw new Error(run.error.message);
  console.log("run", run.data.id, "— calling Gemini…");
  await executeRun(run.data.id);
  const [s] = await sql`
    select status, cost_usd,
      (select count(*) from responses x where x.run_id=r.id) n,
      (select count(*) from responses x where x.run_id=r.id and x.error is not null) err
    from runs r where r.id=${run.data.id}`;
  console.log(`status=${s!.status} n=${s!.n} errors=${s!.err} cost=$${Number(s!.costUsd ?? 0).toFixed(4)}`);
  console.log("RUN_ID", run.data.id);
  await sql.end();
}
main().catch(async (e) => { console.error(e.message); await sql.end(); });
