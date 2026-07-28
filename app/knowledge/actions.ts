"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth";
import { fail, type ActionResult } from "@/lib/actions/result";
import * as svc from "@/lib/claims/service";

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

export async function proposeClaim(input: unknown) {
  return run((u) => svc.proposeClaim(u, input));
}
export async function approveClaim(input: unknown) {
  return run((u) => svc.approveClaim(u, input));
}
export async function rejectClaim(input: unknown) {
  return run((u) => svc.rejectClaim(u, input));
}
export async function setSubjectCompany(input: unknown) {
  return run((u) => svc.setSubjectCompany(u, input));
}
