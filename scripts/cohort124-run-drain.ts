/**
 * Cohort-124 local run drainer (2026-08-31): the single deployed worker
 * executes runs serially (~30-60 min each), so the 6 queued cohort runs
 * would take most of a day. This claims ONLY execute_run jobs for
 * "Cohort 124 batch 1" runs and executes them locally with the same
 * handler, two at a time. Each claimed job's lease (locked_at) is
 * refreshed every 5 minutes so the worker's 15-minute stale-lease sweep
 * cannot reclaim and double-run it.
 *
 * Exits when no cohort execute_run job remains queued.
 * Run: npx tsx scripts/cohort124-run-drain.ts
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { sql } from "@/db/client";
import { completeJob, failJob, type Job } from "@/db/jobs";
import { executeRun } from "@/lib/runs/execute";

const WORKER_ID = `cohort124-runner-${randomUUID().slice(0, 8)}`;
const CONCURRENCY = 2;
const LEASE_REFRESH_MS = 5 * 60_000;

async function claimCohortRunJob(): Promise<Job | null> {
  const rows = await sql<Job[]>`
    update jobs set
      status = 'running', attempts = attempts + 1,
      locked_by = ${WORKER_ID}, locked_at = now()
    where id = (
      select j.id from jobs j
      join runs r on r.id = (j.payload->>'runId')::uuid
      where j.status = 'queued' and j.run_after <= now()
        and j.type = 'execute_run'
        and r.label like 'Cohort 124 batch 1:%'
      order by j.created_at asc
      limit 1
      for update skip locked
    )
    returning id, type, payload, status, attempts
  `;
  return rows[0] ?? null;
}

async function lane(): Promise<void> {
  for (;;) {
    const job = await claimCohortRunJob();
    if (!job) return;
    const runId = job.payload.runId as string;
    console.log(`executing run ${runId} (job ${job.id})`);
    const refresh = setInterval(() => {
      void sql`update jobs set locked_at = now() where id = ${job.id} and locked_by = ${WORKER_ID}`;
    }, LEASE_REFRESH_MS);
    try {
      await executeRun(runId);
      await completeJob(job.id);
      console.log(`run ${runId} complete`);
    } catch (err) {
      await failJob(job, err instanceof Error ? err.message : "unknown");
      console.log(`run ${runId} FAILED: ${err instanceof Error ? err.message : err}`);
    } finally {
      clearInterval(refresh);
    }
  }
}

async function main(): Promise<void> {
  await Promise.all(Array.from({ length: CONCURRENCY }, () => lane()));
  console.log("no cohort execute_run jobs remain — exiting");
  await sql.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
