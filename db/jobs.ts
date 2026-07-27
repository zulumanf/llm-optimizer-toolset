/** Postgres-backed job queue (docs/02): FOR UPDATE SKIP LOCKED leasing,
 * exponential retry backoff, terminal failure after max attempts. */
import { sql, type TransactionSql } from "@/db/client";

export const JOB_MAX_ATTEMPTS = 3;

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

export async function completeJob(jobId: string): Promise<void> {
  await sql`update jobs set status = 'done', locked_by = null where id = ${jobId}`;
}

/** Requeue with backoff, or mark failed after JOB_MAX_ATTEMPTS. */
export async function failJob(job: Job, message: string): Promise<void> {
  if (job.attempts >= JOB_MAX_ATTEMPTS) {
    await sql`
      update jobs set status = 'failed', last_error = ${message}, locked_by = null
      where id = ${job.id}
    `;
  } else {
    const backoffSeconds = 30 * 2 ** (job.attempts - 1);
    await sql`
      update jobs set
        status = 'queued',
        last_error = ${message},
        locked_by = null,
        run_after = now() + make_interval(secs => ${backoffSeconds})
      where id = ${job.id}
    `;
  }
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
