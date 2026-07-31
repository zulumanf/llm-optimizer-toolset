"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth";
import { fail, type ActionResult } from "@/lib/actions/result";
import * as attributionSvc from "@/lib/attribution/service";
import * as taskSvc from "@/lib/tasks/service";

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

export async function createIntervention(input: unknown) {
  return run((u) => attributionSvc.createIntervention(u, input));
}
export async function updateInterventionSchedule(input: unknown) {
  return run((u) => attributionSvc.updateInterventionSchedule(u, input));
}
export async function suggestTask(input: unknown) {
  return run((u) => taskSvc.suggestTask(u, input));
}
export async function approveTask(input: unknown) {
  return run((u) => taskSvc.approveTask(u, input));
}
export async function rejectTask(input: unknown) {
  return run((u) => taskSvc.rejectTask(u, input));
}
export async function startTask(input: unknown) {
  return run((u) => taskSvc.startTask(u, input));
}
export async function completeTask(input: unknown) {
  return run((u) => taskSvc.completeTask(u, input));
}
export async function completeTaskAsIntervention(input: unknown) {
  return run((u) => taskSvc.completeTaskAsIntervention(u, input));
}
export async function suggestTasksFromIntervention(input: unknown) {
  return run((u) => taskSvc.suggestTasksFromIntervention(u, input));
}
export async function updateTaskDetails(input: unknown) {
  return run((u) => taskSvc.updateTaskDetails(u, input));
}
export async function addTaskComment(input: unknown) {
  return run((u) => taskSvc.addTaskComment(u, input));
}
