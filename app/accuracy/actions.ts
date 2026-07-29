"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth";
import { fail, type ActionResult } from "@/lib/actions/result";
import * as svc from "@/lib/accuracy/service";

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

export async function analyzeRunAccuracy(input: unknown) {
  return run((u) => svc.analyzeRunAccuracy(u, input));
}
export async function setFindingStatus(input: unknown) {
  return run((u) => svc.setFindingStatus(u, input));
}
export async function createCorrectionTask(input: unknown) {
  return run((u) => svc.createCorrectionTask(u, input));
}
