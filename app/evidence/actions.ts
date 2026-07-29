"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth";
import { fail, type ActionResult } from "@/lib/actions/result";
import * as evidence from "@/lib/evidence/service";
import { generateEvidenceExport as generateExport } from "@/lib/evidence/export";

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

export async function createAuditSample(input: unknown) {
  return run((u) => evidence.createAuditSample(u, input));
}
export async function generateEvidenceExport(input: unknown) {
  return run((u) => generateExport(u, input));
}
export async function createClientValidationRun(input: unknown) {
  return run((u) => evidence.createClientValidationRun(u, input));
}
export async function recordClientValidationObservation(input: unknown) {
  return run((u) => evidence.recordClientValidationObservation(u, input));
}
