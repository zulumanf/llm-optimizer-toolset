"use server";

import { revalidatePath } from "next/cache";
import { assertCanWrite, getCurrentUser } from "@/lib/auth";
import { fail, type ActionResult } from "@/lib/actions/result";
import * as engagements from "@/lib/engagements/service";
import * as tasks from "@/lib/tasks/service";
import * as portfolio from "@/lib/engagements/portfolio";
import * as reviewers from "@/lib/engagements/reviewers";
import * as profileChecks from "@/lib/profile-corrections/start";
import * as profileCorrections from "@/lib/profile-corrections/approval";
import * as profileDestinations from "@/lib/profile-corrections/destinations";
import * as profileDraftRetry from "@/lib/profile-corrections/retry";

/** Thin wrappers (ui-conventions): identity → service → revalidate. */
async function run<T>(
  projectId: string,
  fn: (user: Awaited<ReturnType<typeof getCurrentUser>>) => Promise<ActionResult<T>>
): Promise<ActionResult<T>> {
  try {
    const user = await getCurrentUser();
    assertCanWrite(user);
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
export async function reviewClientDraft(projectId: string, input: unknown) {
  return run(projectId, (u) => reviewers.reviewClientDraft(u, input));
}
export async function overrideQaEvent(projectId: string, input: unknown) {
  return run(projectId, (u) => portfolio.overrideQaEvent(u, input));
}
/** Spec 147: queue a check of every client-confirmed profile URL (bounded dispatch). */
export async function startProfileChecks(projectId: string) {
  return run(projectId, (u) => profileChecks.startProfileChecks(u, { projectId, origin: "operator" }));
}
/** Spec 147: withdraw a correction request that has not left the platform. */
export async function withdrawCorrectionRequest(projectId: string, input: { correctionRequestId: string; reason: string }) {
  return run(projectId, (u) => profileCorrections.withdrawCorrectionRequest(u, { projectId, ...input }));
}
/** Spec 147: record where corrections for one profile go (archives any previous destination). */
export async function setCorrectionDestination(projectId: string, input: Record<string, unknown>) {
  return run(projectId, (u) => profileDestinations.setCorrectionDestination(u, { ...input, projectId }));
}
/** Spec 147: archive a profile's destination; its waiting requests return to destination_required. */
export async function archiveCorrectionDestination(projectId: string, input: { destinationId: string; reason: string }) {
  return run(projectId, (u) => profileDestinations.archiveCorrectionDestination(u, { projectId, ...input }));
}
/** Spec 147: the client's confirmed contact, offered only as a client_editor prefill. */
export async function clientEditorPrefill(projectId: string) {
  return run(projectId, (u) => profileDestinations.clientEditorPrefill(u, projectId));
}
/** Spec 147: retry an uncertain Gmail draft after the operator checked Gmail. */
export async function retryProfileCorrectionDraft(projectId: string, input: Record<string, unknown>) {
  return run(projectId, (u) => profileDraftRetry.retryProfileCorrectionDraft(u, { ...input, projectId }));
}
