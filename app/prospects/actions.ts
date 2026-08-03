"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth";
import { fail, type ActionResult } from "@/lib/actions/result";
import * as svc from "@/lib/prospects/service";
import * as discovery from "@/lib/prospects/discovery";
import * as buying from "@/lib/prospects/buying-signals";

async function run<T>(
  fn: (user: Awaited<ReturnType<typeof getCurrentUser>>) => Promise<ActionResult<T>>
): Promise<ActionResult<T>> {
  try {
    const user = await getCurrentUser();
    const result = await fn(user);
    if (result.ok) revalidatePath("/prospects", "layout");
    return result;
  } catch (err) {
    return fail(err);
  }
}

export async function createLaunch(input: unknown) {
  return run((u) => svc.createLaunch(u, input));
}
export async function updateLaunchStatus(input: unknown) {
  return run((u) => svc.updateLaunchStatus(u, input));
}
export async function createProspect(input: unknown) {
  return run((u) => svc.createProspect(u, input));
}
export async function updateProspect(input: unknown) {
  return run((u) => svc.updateProspect(u, input));
}
export async function addAuthoritySignal(input: unknown) {
  return run((u) => svc.addAuthoritySignal(u, input));
}
export async function addContact(input: unknown) {
  return run((u) => svc.addContact(u, input));
}
export async function updateContact(input: unknown) {
  return run((u) => svc.updateContact(u, input));
}
export async function archiveContact(input: unknown) {
  return run((u) => svc.archiveContact(u, input));
}
export async function importProspects(input: unknown) {
  return run((u) => svc.importProspects(u, input));
}
export async function recordAssessment(input: unknown) {
  return run((u) => svc.recordAssessment(u, input));
}
export async function computeProspectScore(input: unknown) {
  return run((u) => svc.computeProspectScore(u, input));
}
export async function overrideProspectScore(input: unknown) {
  return run((u) => svc.overrideProspectScore(u, input));
}
export async function runProspectDiscovery(input: unknown) {
  return run((u) => discovery.runProspectDiscovery(u, input));
}
export async function reviewDiscoveryCandidate(input: unknown) {
  return run((u) => discovery.reviewDiscoveryCandidate(u, input));
}
export async function confirmCompanyLink(input: unknown) {
  return run((u) => discovery.confirmCompanyLink(u, input));
}
export async function addBuyingSignal(input: unknown) {
  return run((u) => buying.addBuyingSignal(u, input));
}
export async function archiveBuyingSignal(input: unknown) {
  return run((u) => buying.archiveBuyingSignal(u, input));
}
export async function linkBenchmark(input: unknown) {
  return run((u) => svc.linkBenchmark(u, input));
}
export async function createBenchmarkProject(input: unknown) {
  return run((u) => svc.createBenchmarkProject(u, input));
}
export async function generateFindings(input: unknown) {
  return run((u) => svc.generateFindings(u, input));
}
export async function reviewFinding(input: unknown) {
  return run((u) => svc.reviewFinding(u, input));
}
export async function publishAudit(input: unknown) {
  return run((u) => svc.publishAudit(u, input));
}
export async function revokeAudit(input: unknown) {
  return run((u) => svc.revokeAudit(u, input));
}
export async function createOutreachDraft(input: unknown) {
  return run((u) => svc.createOutreachDraft(u, input));
}
export async function approveOutreachDraft(input: unknown) {
  return run((u) => svc.approveOutreachDraft(u, input));
}
export async function recordDraftSent(input: unknown) {
  return run((u) => svc.recordDraftSent(u, input));
}
export async function sendProspectDraft(input: unknown) {
  return run((u) => svc.sendProspectDraft(u, input));
}
export async function generateRecordingPlan(input: unknown) {
  return run((u) => svc.generateRecordingPlan(u, input));
}
export async function setRecordingStatus(input: unknown) {
  return run((u) => svc.setRecordingStatus(u, input));
}
export async function transitionStage(input: unknown) {
  return run((u) => svc.transitionStage(u, input));
}
export async function addActivityNote(input: unknown) {
  return run((u) => svc.addActivityNote(u, input));
}
