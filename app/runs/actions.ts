"use server";

import { makeActionRunner } from "@/lib/actions/run";
import { fail, type ActionResult } from "@/lib/actions/result";
import { getCurrentUser } from "@/lib/auth";
import * as service from "@/lib/runs/service";

const run = makeActionRunner(["/projects", "layout"]);

export async function startRun(input: unknown) {
  return run((u) => service.startRun(u, input, "manual"));
}

export async function retryFailedCells(input: unknown) {
  return run((u) => service.retryFailedCells(u, input));
}

export async function cancelRun(input: unknown) {
  return run((u) => service.cancelRun(u, input));
}

/** Read-only estimate for the new-run form (no revalidation needed). */
export async function estimateRun(
  input: unknown
): Promise<ActionResult<import("@/lib/runs/cells").RunEstimate>> {
  try {
    await getCurrentUser();
    return await service.estimateRunForVersion(input);
  } catch (err) {
    return fail(err);
  }
}
