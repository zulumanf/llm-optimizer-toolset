"use server";

import { sql } from "@/db/client";
import { makeActionRunner } from "@/lib/actions/run";
import {
  assertCanWrite,
  assertProjectAccess,
  type CurrentUser,
} from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, type ActionResult } from "@/lib/actions/result";
import {
  enqueueForRun,
  jobsForRun,
  type BackgroundJobType,
  type JobStatus,
} from "@/lib/jobs/enqueue";

/**
 * These actions were the audit's "unauthenticated surface": enqueueing spends
 * provider tokens and polling reads run state, and neither asked who was
 * calling. Both now resolve the run's project and hold the caller to their
 * project grant before touching the queue.
 */
async function assertRunAccess(
  user: CurrentUser,
  runId: string
): Promise<void> {
  const [run] = await sql`select project_id from runs where id = ${runId}`;
  if (!run) throw new ClassifiedError("not_found", "Run not found.");
  await assertProjectAccess(user, run.projectId as string);
}

const runWrite = makeActionRunner(["/projects", "layout"]);
const runRead = makeActionRunner();

export async function queueRunJob(input: {
  type: BackgroundJobType;
  runId: string;
}): Promise<ActionResult<{ jobId: string; alreadyQueued: boolean }>> {
  return runWrite(async (user) => {
    assertCanWrite(user); // enqueueing spends provider budget
    await assertRunAccess(user, input.runId);
    return enqueueForRun(input.type, input.runId);
  });
}

/** Polled by the client while a background job is in flight. */
export async function pollRunJobs(input: {
  runId: string;
  types: BackgroundJobType[];
}): Promise<ActionResult<{ jobs: JobStatus[] }>> {
  return runRead(async (user) => {
    await assertRunAccess(user, input.runId);
    return ok({ jobs: await jobsForRun(input.runId, input.types) });
  });
}
