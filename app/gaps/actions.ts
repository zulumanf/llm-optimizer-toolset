"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth";
import { fail, type ActionResult } from "@/lib/actions/result";
import * as svc from "@/lib/gaps/service";

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

export async function analyzeRun(input: unknown) {
  return run((u) => svc.analyzeRun(u, input));
}
export async function createTaskFromFinding(input: unknown) {
  return run((u) => svc.createTaskFromFinding(u, input));
}
export async function dismissFinding(input: unknown) {
  return run((u) => svc.dismissFinding(u, input));
}
