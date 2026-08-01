"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth";
import { fail, type ActionResult } from "@/lib/actions/result";
import * as svc from "@/lib/prospects/service";

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
export async function linkBenchmark(input: unknown) {
  return run((u) => svc.linkBenchmark(u, input));
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
