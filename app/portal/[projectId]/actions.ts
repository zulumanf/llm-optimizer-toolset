"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser, type CurrentUser } from "@/lib/auth";
import { fail, type ActionResult } from "@/lib/actions/result";
import { log } from "@/lib/logger";
import * as onboarding from "@/lib/engagements/client-onboarding";
import * as review from "@/lib/engagements/client-question-review";
import { ONBOARDING_COPY } from "@/lib/portal/client-copy";

/**
 * The portal's only server actions (spec 155). Deliberately NOT the staff
 * action runner: these are client-callable. Each service re-checks
 * `assertClientRespondent` (client role + project grant) and resolves the
 * engagement from the project itself. Unexpected failures never reach the
 * client as technical text.
 */
async function respond<T>(projectId: string, fn: (user: CurrentUser) => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  let result: ActionResult<T>;
  try {
    result = await fn(await getCurrentUser());
  } catch (err) {
    result = fail(err);
  }
  if (!result.ok && result.error.kind === "internal") {
    log("error", "portal.action_failed", { projectId, message: result.error.message });
    return { ok: false, error: { kind: "internal", message: ONBOARDING_COPY.genericError } };
  }
  if (result.ok) revalidatePath(`/portal/${projectId}`, "layout");
  return result;
}

export async function saveOnboardingPriorities(projectId: string, priorities: unknown) {
  return respond(projectId, (u) => onboarding.saveOnboardingPriorities(u, { projectId, priorities }));
}
export async function confirmOnboardingPriorities(projectId: string) {
  return respond(projectId, (u) => onboarding.confirmOnboardingPriorities(u, { projectId }));
}
export async function reopenOnboardingPriorities(projectId: string) {
  return respond(projectId, (u) => onboarding.reopenOnboardingPriorities(u, { projectId }));
}
export async function completeClientOnboarding(projectId: string, contacts: unknown) {
  return respond(projectId, (u) => onboarding.completeClientOnboarding(u, { projectId, contacts }));
}
export async function reviewQuestions(projectId: string, versionId: string, items: unknown) {
  return respond(projectId, (u) => review.reviewQuestions(u, { projectId, versionId, items }));
}
export async function approveRemainingQuestions(projectId: string, versionId: string, segment: string | null) {
  return respond(projectId, (u) => review.approveRemainingQuestions(u, { projectId, versionId, segment }));
}
export async function submitQuestionReview(projectId: string, versionId: string) {
  return respond(projectId, (u) => review.submitQuestionReview(u, { projectId, versionId }));
}
