"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth";
import { fail, type ActionResult } from "@/lib/actions/result";
import * as service from "@/lib/runs/service";

async function run<T>(
  fn: (user: Awaited<ReturnType<typeof getCurrentUser>>) => Promise<ActionResult<T>>
): Promise<ActionResult<T>> {
  try {
    const user = await getCurrentUser();
    const result = await fn(user);
    if (result.ok) revalidatePath("/projects", "layout");
    return result;
  } catch (err) {
    return fail(err);
  }
}

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
