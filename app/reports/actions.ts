"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth";
import { fail, type ActionResult } from "@/lib/actions/result";
import * as svc from "@/lib/reports/service";

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

export async function generateReportDraft(input: unknown) {
  return run((u) => svc.generateReportDraft(u, input));
}
export async function updateReportNarrative(input: unknown) {
  return run((u) => svc.updateReportNarrative(u, input));
}
export async function regenerateReportDraft(input: unknown) {
  return run((u) => svc.regenerateReportDraft(u, input));
}
export async function publishReport(input: unknown) {
  return run((u) => svc.publishReport(u, input));
}
export async function deleteDraft(input: unknown) {
  return run((u) => svc.deleteDraft(u, input));
}
