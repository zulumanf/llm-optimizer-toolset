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

export const signClient = (projectId: string, input: unknown) => run(projectId, (u) => engagements.signClient(u, input));
export const recordContractStatus = (projectId: string, input: unknown) => run(projectId, (u) => engagements.recordContractStatus(u, input));
export const recordBillingEvent = (projectId: string, input: unknown) => run(projectId, (u) => engagements.recordBillingEvent(u, input));
export const confirmMarketDefinition = (projectId: string, input: unknown) => run(projectId, (u) => engagements.confirmMarketDefinition(u, input));
export const setMarketingPermissions = (projectId: string, input: unknown) => run(projectId, (u) => engagements.setMarketingPermissions(u, input));
export const startOnboarding = (projectId: string, input: unknown) => run(projectId, (u) => engagements.startOnboarding(u, input));
export const activateExclusivity = (projectId: string, input: unknown) => run(projectId, (u) => engagements.activateExclusivity(u, input));
export const markActive = (projectId: string, input: unknown) => run(projectId, (u) => engagements.markActive(u, input));
export const addContextItem = (projectId: string, input: unknown) => run(projectId, (u) => engagements.addContextItem(u, input));
export const setAccessStatus = (projectId: string, input: unknown) => run(projectId, (u) => engagements.setAccessStatus(u, input));
export const freezeBaseline = (projectId: string, input: unknown) => run(projectId, (u) => engagements.freezeBaseline(u, input));
export const recordMeasurement = (projectId: string, input: unknown) => run(projectId, (u) => engagements.recordMeasurement(u, input));
export const recordClientUpdateSent = (projectId: string, input: unknown) => run(projectId, (u) => engagements.recordClientUpdateSent(u, input));
export const pauseMarketOutreach = (projectId: string, input: unknown) => run(projectId, (u) => engagements.pauseMarketOutreach(u, input));
export const setRenewalStatus = (projectId: string, input: unknown) => run(projectId, (u) => engagements.setRenewalStatus(u, input));
export const renewEngagement = (projectId: string, input: unknown) => run(projectId, (u) => engagements.renewEngagement(u, input));
export const closeEngagement = (projectId: string, input: unknown) => run(projectId, (u) => engagements.closeEngagement(u, input));
export const updateTaskProvenance = (projectId: string, input: unknown) => run(projectId, (u) => tasks.updateTaskProvenance(u, input));
export const blockTask = (projectId: string, input: unknown) => run(projectId, (u) => tasks.blockTask(u, input));
export const unblockTask = (projectId: string, input: unknown) => run(projectId, (u) => tasks.unblockTask(u, input));
export const recordClientDecision = (projectId: string, input: unknown) => run(projectId, (u) => tasks.recordClientDecision(u, input));
export const suggestTask = (projectId: string, input: unknown) => run(projectId, (u) => tasks.suggestTask(u, input));
