"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth";
import { fail, type ActionResult } from "@/lib/actions/result";
import * as svc from "@/lib/competitors/service";

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

export async function addCompetitor(input: unknown) {
  return run((u) => svc.addCompetitor(u, input));
}
export async function updateCompetitorTier(input: unknown) {
  return run((u) => svc.updateCompetitorTier(u, input));
}
export async function archiveCompetitor(input: unknown) {
  return run((u) => svc.archiveCompetitor(u, input));
}
export async function trackBrandCandidate(input: unknown) {
  return run((u) => svc.trackBrandCandidate(u, input));
}
export async function dismissBrandCandidate(input: unknown) {
  return run((u) => svc.dismissBrandCandidate(u, input));
}
