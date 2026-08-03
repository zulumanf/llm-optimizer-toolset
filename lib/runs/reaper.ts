/**
 * Benchmark-run reaper (production-readiness plan 2.5). A worker that dies
 * mid-run leaves the run at 'running'; after JOB_MAX_ATTEMPTS the
 * execute_run job dead-letters and nothing else will ever touch the run —
 * no terminal status, no completed_at, invisible to every "what needs
 * attention" surface. The workflow engine got a stale-node reaper for the
 * same failure mode; this is the benchmark runner's.
 *
 * A run is orphaned when it says 'running' but no execute_run job for it is
 * queued or running — retry backoff keeps the job 'queued', so runs mid-retry
 * are never touched. Reaped runs go to 'failed' (already surfaced by the
 * Today feed) with the reason in status_detail.
 */
import { sql } from "@/db/client";
import { log } from "@/lib/logger";

export async function reapOrphanedRuns(): Promise<number> {
  const rows = await sql`
    update runs set
      status = 'failed',
      status_detail = 'Reaped: the execute_run job dead-lettered or vanished while this run was in flight. Retry the run to re-execute unfinished cells.',
      completed_at = now()
    where status = 'running'
      and not exists (
        select 1 from jobs j
        where j.type = 'execute_run'
          and j.payload->>'runId' = runs.id::text
          and j.status in ('queued', 'running')
      )
    returning id
  `;
  if (rows.length > 0) {
    log("error", "runs.reaped_orphaned", {
      count: rows.length,
      runIds: rows.map((r) => r.id as string),
    });
  }
  return rows.length;
}
