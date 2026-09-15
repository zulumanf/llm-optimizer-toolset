/**
 * Touch 1 benchmark refresh (2026-09-13): re-capture the frozen OpenAI
 * benchmark for launches whose runs are crossing the spec 124 14-day limit,
 * with the SAME project, prompt-set version and provider config as the
 * launch's previous run (no methodology drift), then link every prospect
 * in the launch to the new run so competitiveMismatchReview reads it.
 *
 *   start   --launches <id,id,...> [--budget 8]   start one run per launch
 *   drain   [--concurrency 2]                      execute queued refresh runs locally
 *   postrun                                        link prospects → new runs, findings
 *
 * Refresh runs are labelled `T1 refresh <date>: <market>`; drain claims only
 * those jobs (the deployed worker keeps its own queue). Nothing sends.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { sql } from "@/db/client";
import { completeJob, failJob, type Job } from "@/db/jobs";
import type { CurrentUser } from "@/lib/auth";
import { executeRun } from "@/lib/runs/execute";
import { estimateRunForVersion, startRun } from "@/lib/runs/service";
import * as svc from "@/lib/prospects/service";

const LABEL_PREFIX = "T1 refresh";
const WORKER_ID = `t1-refresh-${randomUUID().slice(0, 8)}`;
const LEASE_REFRESH_MS = 5 * 60_000;
const KIND_PREFERENCE = ["authority_visibility_gap", "absence", "competitor_contrast"];

function arg(flag: string, dflt: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? dflt) : dflt;
}

async function operatorUser(): Promise<CurrentUser> {
  const [u] = await sql`select id, email, name, role from users where email = 'zulumanf@gmail.com'`;
  if (!u) throw new Error("Operator user not found.");
  return { id: u.id as string, email: u.email as string, name: u.name as string, role: u.role as CurrentUser["role"] };
}

async function start(user: CurrentUser): Promise<void> {
  const launchIds = arg("--launches", "").split(",").map((s) => s.trim()).filter(Boolean);
  const budgetUsd = Number(arg("--budget", "8"));
  const today = new Date().toISOString().slice(0, 10);
  for (const launchId of launchIds) {
    const [prev] = await sql`
      select distinct on (l.id) m.name || ', ' || coalesce(m.state_code, '?') as market, r.project_id, r.prompt_set_version_id, r.providers
      from market_launches l join markets m on m.id = l.market_id
      join prospects p on p.launch_id = l.id and p.archived_at is null
      join prospect_benchmarks b on b.prospect_id = p.id join runs r on r.id = b.run_id
      where l.id = ${launchId} and r.completed_at is not null
      order by l.id, r.completed_at desc`;
    if (!prev) { console.log(`SKIP ${launchId}: no prior completed run`); continue; }
    const label = `${LABEL_PREFIX} ${today}: ${prev.market}`;
    const [dup] = await sql`select id from runs where label = ${label} and status not in ('failed')`;
    if (dup) { console.log(`EXISTS ${label} → ${dup.id}`); continue; }
    const providers = prev.providers as { provider: string; model: string; repetitions: number }[];
    const est = await estimateRunForVersion({ promptSetVersionId: prev.promptSetVersionId as string, providers });
    if (!est.ok) { console.log(`ESTIMATE FAILED ${label}: ${est.error.message}`); continue; }
    const run = await startRun(user, { projectId: prev.projectId, promptSetVersionId: prev.promptSetVersionId, providers, budgetUsd, label }, "manual");
    if (!run.ok) { console.log(`START FAILED ${label}: ${run.error.message}`); continue; }
    console.log(`STARTED ${label} → ${run.data.id} · est $${(est.data.estimatedMicroUsd / 1_000_000).toFixed(2)}`);
  }
}

async function claim(): Promise<Job | null> {
  const rows = await sql<Job[]>`
    update jobs set status = 'running', attempts = attempts + 1, locked_by = ${WORKER_ID}, locked_at = now()
    where id = (
      select j.id from jobs j join runs r on r.id = (j.payload->>'runId')::uuid
      where j.status = 'queued' and j.run_after <= now() and j.type = 'execute_run' and r.label like ${LABEL_PREFIX + "%"}
      order by j.created_at asc limit 1 for update skip locked)
    returning id, type, payload, status, attempts`;
  return rows[0] ?? null;
}

async function lane(): Promise<void> {
  for (;;) {
    const job = await claim();
    if (!job) return;
    const runId = job.payload.runId as string;
    console.log(`executing run ${runId}`);
    const refresh = setInterval(() => { void sql`update jobs set locked_at = now() where id = ${job.id} and locked_by = ${WORKER_ID}`; }, LEASE_REFRESH_MS);
    try { await executeRun(runId); await completeJob(job.id); console.log(`run ${runId} complete`); }
    catch (err) { await failJob(job, err instanceof Error ? err.message : "unknown"); console.log(`run ${runId} FAILED: ${err instanceof Error ? err.message : err}`); }
    finally { clearInterval(refresh); }
  }
}

async function postrun(user: CurrentUser): Promise<void> {
  // Only runs whose OpenAI capture is COMPLETE are linked: a short run would
  // bind every prospect to evidence spec 136 refuses (BENCHMARK_INCOMPLETE)
  // and displace a usable link.
  const runs = await sql`
    select r.id, r.label, r.status,
      (select count(*) from responses x where x.run_id = r.id and x.provider = 'openai' and x.error is null)::int as openai_ok,
      (select jsonb_array_length(v.frozen_prompts) from prompt_set_versions v where v.id = r.prompt_set_version_id)
        * coalesce((select (p->>'repetitions')::int from jsonb_array_elements(r.providers) p where p->>'provider' = 'openai' limit 1), 1) as openai_expected
    from runs r where r.label like ${LABEL_PREFIX + "%"} and r.completed_at is not null and r.status in ('completed', 'partial')`;
  const { computeScores } = await import("@/lib/scoring/compute");
  for (const run of runs) {
    if (Number(run.openaiOk) < Number(run.openaiExpected)) { console.log(`SKIP ${run.label}: openai ${run.openaiOk}/${run.openaiExpected} (incomplete — retry the run when credits allow)`); continue; }
    const tail = (run.label as string).split(": ").slice(1).join(": ");
    const city = tail.split(",")[0]!.trim();
    const st = tail.split(",")[1]?.trim() ?? "";
    const [launch] = await sql`
      select l.id from market_launches l join markets m on m.id = l.market_id
      where l.archived_at is null and lower(m.name) = ${city.toLowerCase()} and coalesce(m.state_code, '?') = ${st}
      order by l.created_at desc limit 1`;
    if (!launch) { console.log(`no launch for ${run.label}`); continue; }
    await computeScores(run.id as string);
    const prospects = await sql`select id, business_name from prospects where launch_id = ${launch.id} and archived_at is null and company_id is not null`;
    let linked = 0;
    for (const p of prospects) {
      const link = await svc.linkBenchmark(user, { prospectId: p.id as string, runId: run.id as string });
      const benchmarkId = link.ok ? (link.data.benchmarkId as string) : ((await sql`select id from prospect_benchmarks where prospect_id = ${p.id} and run_id = ${run.id}`)[0]?.id as string | undefined);
      if (!benchmarkId) { console.log(`  link failed ${p.businessName}: ${link.ok ? "?" : link.error.message}`); continue; }
      await svc.computeProspectScore(user, { prospectId: p.id as string });
      await svc.generateFindings(user, { benchmarkId });
      const cands = await sql`select id, kind, status from prospect_findings where prospect_id = ${p.id} and benchmark_id = ${benchmarkId} order by created_at desc`;
      if (!cands.some((c) => c.status === "approved")) {
        const pick = KIND_PREFERENCE.map((k) => cands.find((c) => c.kind === k && c.status === "candidate")).find(Boolean) ?? cands.find((c) => c.status === "candidate");
        if (pick) await svc.reviewFinding(user, { findingId: pick.id as string, decision: "approved", makePrimary: true });
      }
      linked += 1;
    }
    console.log(`${run.label} (${run.status}): ${linked}/${prospects.length} prospects linked to ${run.id}`);
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const user = await operatorUser();
  if (cmd === "start") await start(user);
  else if (cmd === "drain") { await Promise.all(Array.from({ length: Number(arg("--concurrency", "2")) }, () => lane())); console.log("no refresh execute_run jobs remain"); }
  else if (cmd === "postrun") await postrun(user);
  else throw new Error("usage: start|drain|postrun");
  await sql.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
