"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth";
import { fail, type ActionResult } from "@/lib/actions/result";
import * as svc from "@/lib/content/service";

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

export async function createBriefFromFinding(input: unknown) {
  return run((u) => svc.createBriefFromFinding(u, input));
}
export async function generateDraft(input: unknown) {
  return run((u) => svc.generateDraft(u, input));
}
export async function verifyDraft(input: unknown) {
  return run((u) => svc.verifyDraft(u, input));
}
export async function approveAsset(input: unknown) {
  return run((u) => svc.approveAsset(u, input));
}
export async function markPublished(input: unknown) {
  return run((u) => svc.markPublished(u, input));
}
