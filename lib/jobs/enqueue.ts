/**
 * Enqueue helpers for long operations (UX pass). Agent analyses and export
 * packaging take tens of seconds; running them inside a server action froze
 * the page and lost the work if the operator navigated away. These hand the
 * work to the existing Postgres queue — which already gives us leases,
 * retries, and crash recovery — and the page polls for the result.
 *
 * Duplicate protection: a queued or running job for the same (type, run) is
 * reused rather than stacked, so double-clicking a button costs nothing.
 */
import { sql } from "@/db/client";
import { enqueueJob } from "@/db/jobs";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";

export type BackgroundJobType =
  | "analyze_gaps"
  | "analyze_accuracy"
  | "build_evidence_export";

export interface JobStatus {
  id: string;
  type: string;
  status: string;
  attempts: number;
  lastError: string | null;
}

export async function enqueueForRun(
  type: BackgroundJobType,
  runId: string
): Promise<ActionResult<{ jobId: string; alreadyQueued: boolean }>> {
  try {
    const [existing] = await sql`
      select id from jobs
      where type = ${type} and payload->>'runId' = ${runId}
        and status in ('queued', 'running')
      limit 1
    `;
    if (existing) {
      return ok({ jobId: existing.id as string, alreadyQueued: true });
    }
    const jobId = await enqueueJob(sql, type, { runId });
    return ok({ jobId, alreadyQueued: false });
  } catch (err) {
    return fail(
      err instanceof ClassifiedError
        ? err
        : new ClassifiedError("internal", "Could not queue the job.")
    );
  }
}

/** Live status for the jobs a page is watching, so the UI can show progress
 * and surface failures instead of silently doing nothing. */
export async function jobsForRun(
  runId: string,
  types: BackgroundJobType[]
): Promise<JobStatus[]> {
  if (types.length === 0) return [];
  return sql<JobStatus[]>`
    select id, type, status, attempts, last_error from jobs
    where payload->>'runId' = ${runId} and type = any(${types})
    order by created_at desc limit 10
  `;
}
