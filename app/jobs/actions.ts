"use server";

import { revalidatePath } from "next/cache";
import { fail, type ActionResult } from "@/lib/actions/result";
import {
  enqueueForRun,
  jobsForRun,
  type BackgroundJobType,
  type JobStatus,
} from "@/lib/jobs/enqueue";

export async function queueRunJob(input: {
  type: BackgroundJobType;
  runId: string;
}): Promise<ActionResult<{ jobId: string; alreadyQueued: boolean }>> {
  try {
    const result = await enqueueForRun(input.type, input.runId);
    if (result.ok) revalidatePath("/projects", "layout");
    return result;
  } catch (err) {
    return fail(err);
  }
}

/** Polled by the client while a background job is in flight. */
export async function pollRunJobs(input: {
  runId: string;
  types: BackgroundJobType[];
}): Promise<ActionResult<{ jobs: JobStatus[] }>> {
  try {
    const jobs = await jobsForRun(input.runId, input.types);
    return { ok: true, data: { jobs } };
  } catch (err) {
    return fail(err);
  }
}
