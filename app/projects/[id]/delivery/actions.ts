"use server";

import { makeActionRunner } from "@/lib/actions/run";
import * as clientOnboarding from "@/lib/engagements/client-onboarding";
import * as delivery from "@/lib/engagements/delivery";
import * as engagements from "@/lib/engagements/service";
import * as intake from "@/lib/engagements/onboarding-intake";
import * as plans from "@/lib/plans/service";

/** Thin wrappers (ui-conventions): identity → service → revalidate. Every
 * service re-checks role (staff only) and scope itself; the projectId
 * argument is never trusted for authorization. */
const runner = makeActionRunner(["/projects", "layout"], ["/portal", "layout"]);
const run = <T,>(_projectId: string, fn: Parameters<typeof runner<T>>[0]) => runner(fn);

export async function prepareClientOnboarding(projectId: string, input: unknown) {
  return run(projectId, (u) => clientOnboarding.prepareClientOnboarding(u, input));
}
export async function markOnboardingReady(projectId: string, input: unknown) {
  return run(projectId, (u) => clientOnboarding.markOnboardingReady(u, input));
}
export async function completeIntake(projectId: string, input: unknown) {
  return run(projectId, (u) => intake.completeOnboardingIntake(u, input));
}
export async function importClientQuestions(projectId: string, input: unknown) {
  return run(projectId, (u) => delivery.importClientQuestions(u, input));
}
export async function recordSubjectDecision(projectId: string, input: unknown) {
  return run(projectId, (u) => delivery.recordSubjectDecision(u, input));
}
export async function saveProtocolDraft(projectId: string, input: unknown) {
  return run(projectId, (u) => delivery.saveProtocolDraft(u, input));
}
export async function acceptProtocol(projectId: string, input: unknown) {
  return run(projectId, (u) => delivery.acceptProtocol(u, input));
}
export async function freezeBaseline(projectId: string, input: unknown) {
  return run(projectId, (u) => engagements.freezeBaseline(u, input));
}
export async function previewBaselineFreeze(projectId: string, input: unknown) {
  return run(projectId, (u) => engagements.previewBaselineFreeze(u, input));
}
export async function voidBaseline(projectId: string, input: unknown) {
  return run(projectId, (u) => engagements.voidBaseline(u, input));
}
export async function generateWelcomeDraft(projectId: string, input: unknown) {
  return run(projectId, (u) => delivery.generateWelcomeDraft(u, input));
}
export async function generateWeeklyDraft(projectId: string, input: unknown) {
  return run(projectId, (u) => delivery.generateWeeklyDraft(u, input));
}
export async function generateFinalReviewDraft(projectId: string, input: unknown) {
  return run(projectId, (u) => delivery.generateFinalReviewDraft(u, input));
}
export async function markUpdateSent(projectId: string, input: unknown) {
  return run(projectId, (u) => delivery.markUpdateSent(u, input));
}
export async function discardUpdate(projectId: string, input: unknown) {
  return run(projectId, (u) => delivery.discardUpdate(u, input));
}
export async function scheduleMeeting(projectId: string, input: unknown) {
  return run(projectId, (u) => delivery.scheduleMeeting(u, input));
}
export async function recordMeetingNotes(projectId: string, input: unknown) {
  return run(projectId, (u) => delivery.recordMeetingNotes(u, input));
}
export async function importExternalMeasurement(projectId: string, input: unknown) {
  return run(projectId, (u) => delivery.importExternalMeasurement(u, input));
}
export async function setExternalMeasurementQa(projectId: string, input: unknown) {
  return run(projectId, (u) => delivery.setExternalMeasurementQa(u, input));
}
export async function draftPlanFromBaseline(projectId: string) {
  return run(projectId, (u) => delivery.draftPlanFromBaseline(u, { projectId }));
}
export async function createManualPlan(projectId: string) {
  return run(projectId, (u) => delivery.createManualPlan(u, { projectId }));
}
export async function addPlanItem(projectId: string, input: unknown) {
  return run(projectId, (u) => delivery.addPlanItem(u, input));
}
export async function updatePlanItem(projectId: string, input: unknown) {
  return run(projectId, (u) => delivery.updatePlanItem(u, input));
}
export async function applyPhaseDueDates(projectId: string, input: unknown) {
  return run(projectId, (u) => delivery.applyPhaseDueDates(u, input));
}
export async function publishPlan(projectId: string, input: unknown) {
  return run(projectId, (u) => plans.approvePlan(u, input));
}
export async function activatePlanItem(projectId: string, input: unknown) {
  return run(projectId, (u) => plans.activatePlanItem(u, input));
}
