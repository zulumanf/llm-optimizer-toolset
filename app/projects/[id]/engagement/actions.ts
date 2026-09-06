"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth";
import { fail, type ActionResult } from "@/lib/actions/result";
import * as engagements from "@/lib/engagements/service";
import * as tasks from "@/lib/tasks/service";

/** Thin wrappers (ui-conventions): identity → service → revalidate. */
async function run<T>(
  projectId: string,
  fn: (user: Awaited<ReturnType<typeof getCurrentUser>>) => Promise<ActionResult<T>>
): Promise<ActionResult<T>> {
  try {
    const user = await getCurrentUser();
    const result = await fn(user);
    if (result.ok) {
      revalidatePath(`/projects/${projectId}/engagement`);
      revalidatePath(`/projects/${projectId}/tasks`);
      revalidatePath(`/portal/${projectId}`);
      revalidatePath("/");
    }
    return result;
  } catch (err) {
    return fail(err);
  }
}

export async function signClient(projectId: string, input: unknown) {
  return run(projectId, (u) => engagements.signClient(u, input));
}
export async function recordContractStatus(projectId: string, input: unknown) {
  return run(projectId, (u) => engagements.recordContractStatus(u, input));
}
export async function recordBillingEvent(projectId: string, input: unknown) {
  return run(projectId, (u) => engagements.recordBillingEvent(u, input));
}
export async function confirmMarketDefinition(projectId: string, input: unknown) {
  return run(projectId, (u) => engagements.confirmMarketDefinition(u, input));
}
export async function setMarketingPermissions(projectId: string, input: unknown) {
  return run(projectId, (u) => engagements.setMarketingPermissions(u, input));
}
export async function startOnboarding(projectId: string, input: unknown) {
  return run(projectId, (u) => engagements.startOnboarding(u, input));
}
export async function activateExclusivity(projectId: string, input: unknown) {
  return run(projectId, (u) => engagements.activateExclusivity(u, input));
}
export async function markActive(projectId: string, input: unknown) {
  return run(projectId, (u) => engagements.markActive(u, input));
}
export async function addContextItem(projectId: string, input: unknown) {
  return run(projectId, (u) => engagements.addContextItem(u, input));
}
export async function setAccessStatus(projectId: string, input: unknown) {
  return run(projectId, (u) => engagements.setAccessStatus(u, input));
}
export async function freezeBaseline(projectId: string, input: unknown) {
  return run(projectId, (u) => engagements.freezeBaseline(u, input));
}
export async function recordMeasurement(projectId: string, input: unknown) {
  return run(projectId, (u) => engagements.recordMeasurement(u, input));
}
export async function recordClientUpdateSent(projectId: string, input: unknown) {
  return run(projectId, (u) => engagements.recordClientUpdateSent(u, input));
}
export async function pauseMarketOutreach(projectId: string, input: unknown) {
  return run(projectId, (u) => engagements.pauseMarketOutreach(u, input));
}
export async function setRenewalStatus(projectId: string, input: unknown) {
  return run(projectId, (u) => engagements.setRenewalStatus(u, input));
}
export async function renewEngagement(projectId: string, input: unknown) {
  return run(projectId, (u) => engagements.renewEngagement(u, input));
}
export async function closeEngagement(projectId: string, input: unknown) {
  return run(projectId, (u) => engagements.closeEngagement(u, input));
}
export async function updateTaskProvenance(projectId: string, input: unknown) {
  return run(projectId, (u) => tasks.updateTaskProvenance(u, input));
}
export async function blockTask(projectId: string, input: unknown) {
  return run(projectId, (u) => tasks.blockTask(u, input));
}
export async function unblockTask(projectId: string, input: unknown) {
  return run(projectId, (u) => tasks.unblockTask(u, input));
}
export async function recordClientDecision(projectId: string, input: unknown) {
  return run(projectId, (u) => tasks.recordClientDecision(u, input));
}
export async function suggestTask(projectId: string, input: unknown) {
  return run(projectId, (u) => tasks.suggestTask(u, input));
}
