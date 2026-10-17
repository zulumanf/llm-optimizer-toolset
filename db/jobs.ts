/** Postgres-backed job queue (docs/02): FOR UPDATE SKIP LOCKED leasing,
 * exponential retry backoff, terminal failure after max attempts. */
import { sql, type TransactionSql } from "@/db/client";

export const JOB_MAX_ATTEMPTS = 3;
/** Renew a running job's lease this often; far below the 15-minute stale
 * threshold (workers/index.ts) so one missed beat never loses a lease. */
export const LEASE_RENEW_INTERVAL_MS = 60_000;

export interface Job {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  status: "queued" | "running" | "done" | "failed";
  attempts: number;
}

export async function enqueueJob(
  tx: TransactionSql | typeof sql,
  type: string,
  payload: Record<string, unknown>
): Promise<string> {
  const [row] = await tx`
    insert into jobs (type, payload) values (${type}, ${tx.json(payload as never)})
    returning id
  `;
  return row?.id as string;
}

/** Lease the oldest runnable job. Returns null when the queue is empty. */
export async function claimNextJob(workerId: string): Promise<Job | null> {
  const rows = await sql<Job[]>`
    update jobs set
      status = 'running',
      attempts = attempts + 1,
      locked_by = ${workerId},
      locked_at = now()
    where id = (
      select id from jobs
      where status = 'queued' and run_after <= now()
      order by created_at asc
      limit 1
      for update skip locked
    )
    returning id, type, payload, status, attempts
  `;
  return rows[0] ?? null;
}

/**
 * Fencing (spec 151 C2): when a worker id is given, the write only lands if
 * that worker still holds the lease. A job reclaimed from a stalled worker
 * and re-claimed by another can then never be completed or failed by the
 * original — the stale write is a no-op and returns false. Callers without a
 * worker id (tests, scripts) keep the unfenced behavior.
 */
const fence = (workerId: string | undefined) =>
  workerId === undefined ? sql`` : sql`and locked_by = ${workerId} and status = 'running'`;

export async function completeJob(jobId: string, workerId?: string): Promise<boolean> {
  const rows = await sql`
    update jobs set status = 'done', locked_by = null where id = ${jobId} ${fence(workerId)}
    returning id
  `;
  return rows.length > 0;
}

/** Requeue with backoff, or mark failed after JOB_MAX_ATTEMPTS. */
export async function failJob(job: Job, message: string, workerId?: string): Promise<boolean> {
  if (job.attempts >= JOB_MAX_ATTEMPTS) {
    const rows = await sql`
      update jobs set status = 'failed', last_error = ${message}, locked_by = null
      where id = ${job.id} ${fence(workerId)}
      returning id
    `;
    return rows.length > 0;
  }
  const backoffSeconds = 30 * 2 ** (job.attempts - 1);
  const rows = await sql`
    update jobs set
      status = 'queued',
      last_error = ${message},
      locked_by = null,
      run_after = now() + make_interval(secs => ${backoffSeconds})
    where id = ${job.id} ${fence(workerId)}
    returning id
  `;
  return rows.length > 0;
}

/** Extend a held lease. False means the lease was lost (reclaimed). */
export async function renewLease(jobId: string, workerId: string): Promise<boolean> {
  const rows = await sql`
    update jobs set locked_at = now()
    where id = ${jobId} and locked_by = ${workerId} and status = 'running'
    returning id
  `;
  return rows.length > 0;
}

/** Reclaim jobs whose worker died mid-lease (no heartbeat for `minutes`). */
export async function reclaimStaleJobs(minutes: number): Promise<number> {
  const rows = await sql`
    update jobs set status = 'queued', locked_by = null
    where status = 'running'
      and locked_at < now() - make_interval(mins => ${minutes})
    returning id
  `;
  return rows.length;
}

// ---------------------------------------------------------------------------
// Release 151: execution exclusivity by session advisory lock.
//
// The lease (locked_by / locked_at) is a liveness hint used to reclaim jobs
// from dead workers. Exclusivity is the advisory lock below: a job runs only
// while its worker's DEDICATED connection holds pg_advisory_lock(151, job).
// A reclaimed job that is in fact still running cannot be executed twice —
// the second claimant fails to take the lock and hands the job back. A
// crashed worker's connection closes and the lock goes with it.

export const JOB_LOCK_CLASS = 151;
/** A claim that could not take the execution lock is retried after this. */
export const JOB_LOCK_RETRY_SECONDS = 60;

/** Hand a claimed-but-not-started job back without burning an attempt. */
export async function releaseClaim(jobId: string, workerId: string): Promise<void> {
  // The attempt this claim added is ALWAYS given back — even when the real
  // executor's heartbeat has meanwhile re-asserted its lease (then the lease
  // and status are left exactly as the executor set them). Otherwise a
  // deferred claim would silently consume one of the job's attempts.
  await sql`
    update jobs set
      attempts = greatest(attempts - 1, 0),
      status = case when locked_by = ${workerId} and status = 'running' then 'queued' else status end,
      run_after = case when locked_by = ${workerId} and status = 'running'
        then now() + make_interval(secs => ${JOB_LOCK_RETRY_SECONDS}) else run_after end,
      locked_by = case when locked_by = ${workerId} then null else locked_by end
    where id = ${jobId}
  `;
}

/** While holding the execution lock: (re)assert this worker's lease. */
export async function renewLeaseHeld(jobId: string, workerId: string): Promise<void> {
  await sql`
    update jobs set locked_at = now(), locked_by = ${workerId}, status = 'running'
    where id = ${jobId} and status in ('running', 'queued')
  `;
}

/** While holding the execution lock: settle the job (no-op if already done). */
export async function completeJobHeld(jobId: string): Promise<void> {
  await sql`update jobs set status = 'done', locked_by = null where id = ${jobId} and status <> 'done'`;
}

export async function failJobHeld(job: Job, message: string): Promise<void> {
  const [row] = await sql`select attempts from jobs where id = ${job.id}`;
  const attempts = Math.max(job.attempts, Number(row?.attempts ?? job.attempts));
  if (attempts >= JOB_MAX_ATTEMPTS) {
    await sql`
      update jobs set status = 'failed', last_error = ${message}, locked_by = null
      where id = ${job.id} and status <> 'done'
    `;
  } else {
    const backoffSeconds = 30 * 2 ** (attempts - 1);
    await sql`
      update jobs set status = 'queued', last_error = ${message}, locked_by = null,
        run_after = now() + make_interval(secs => ${backoffSeconds})
      where id = ${job.id} and status <> 'done'
    `;
  }
}
