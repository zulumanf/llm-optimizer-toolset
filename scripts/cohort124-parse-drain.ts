/**
 * Cohort-124 local parse drainer (2026-08-31): the deployed worker is a
 * single serial loop and today's weekly baseline queued ~34k parse jobs
 * ahead of the cohort's. This claims ONLY parse_response jobs belonging to
 * "Cohort 124 batch 1" runs — same lease/complete/fail semantics as the
 * worker (FOR UPDATE SKIP LOCKED), same parseResponse handler — with local
 * concurrency so cohort eligibility isn't a day behind the benchmark.
 *
 * Exits when every cohort run is completed and no cohort parse job remains.
 * Run: npx tsx scripts/cohort124-parse-drain.ts
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { sql } from "@/db/client";
import { completeJob, failJob, type Job } from "@/db/jobs";
import { parseResponse } from "@/lib/parsing/service";

const WORKER_ID = `cohort124-local-${randomUUID().slice(0, 8)}`;
const CONCURRENCY = 6;
const IDLE_MS = 15_000;

async function cohortResponseIds(): Promise<string[]> {
  const rows = await sql`
    select x.id from responses x
    join runs r on r.id = x.run_id
    where r.label like 'Cohort 124 batch 1:%'`;
  return rows.map((r) => r.id as string);
}

async function claimCohortParseJob(ids: string[]): Promise<Job | null> {
  const rows = await sql<Job[]>`
    update jobs set
      status = 'running', attempts = attempts + 1,
      locked_by = ${WORKER_ID}, locked_at = now()
    where id = (
      select id from jobs
      where status = 'queued' and run_after <= now()
        and type = 'parse_response'
        and payload->>'responseId' = any(${ids})
      order by created_at asc
      limit 1
      for update skip locked
    )
    returning id, type, payload, status, attempts
  `;
  return rows[0] ?? null;
}

async function allRunsDone(): Promise<boolean> {
  const [r] = await sql`
    select count(*) filter (where completed_at is null)::int as open
    from runs where label like 'Cohort 124 batch 1:%'`;
  return Number(r!.open) === 0;
}

async function lane(getIds: () => string[]): Promise<void> {
  for (;;) {
    const job = await claimCohortParseJob(getIds());
    if (!job) return;
    try {
      await parseResponse(job.payload.responseId as string);
      await completeJob(job.id);
    } catch (err) {
      await failJob(job, err instanceof Error ? err.message : "unknown");
    }
  }
}

async function main(): Promise<void> {
  let done = 0;
  for (;;) {
    const ids = await cohortResponseIds();
    const getIds = () => ids;
    const [pending] = await sql`
      select count(*)::int as n from jobs
      where status = 'queued' and type = 'parse_response'
        and payload->>'responseId' = any(${ids})`;
    if (Number(pending!.n) > 0) {
      const before = Date.now();
      await Promise.all(Array.from({ length: CONCURRENCY }, () => lane(getIds)));
      done += Number(pending!.n);
      console.log(
        `drained ~${pending!.n} cohort parse jobs in ${Math.round((Date.now() - before) / 1000)}s (total ~${done})`
      );
    } else if (await allRunsDone()) {
      console.log("all cohort runs completed and parsed — exiting");
      break;
    } else {
      await new Promise((r) => setTimeout(r, IDLE_MS));
    }
  }
  await sql.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
