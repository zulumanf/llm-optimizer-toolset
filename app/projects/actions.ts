"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth";
import { fail, type ActionResult } from "@/lib/actions/result";
import type { Project } from "@/db/projects";
import * as service from "@/lib/projects/service";

async function withUserAndRevalidate(
  fn: (user: Awaited<ReturnType<typeof getCurrentUser>>) => Promise<ActionResult<Project>>
): Promise<ActionResult<Project>> {
  try {
    const user = await getCurrentUser();
    const result = await fn(user);
    if (result.ok) {
      revalidatePath("/projects");
      revalidatePath(`/projects/${result.data.id}`);
    }
    return result;
  } catch (err) {
    return fail(err);
  }
}

export async function createProject(input: unknown): Promise<ActionResult<Project>> {
  return withUserAndRevalidate((user) => service.createProject(user, input));
}

export async function updateProject(input: unknown): Promise<ActionResult<Project>> {
  return withUserAndRevalidate((user) => service.updateProject(user, input));
}

export async function archiveProject(input: unknown): Promise<ActionResult<Project>> {
  return withUserAndRevalidate((user) => service.archiveProject(user, input));
}

export async function unarchiveProject(input: unknown): Promise<ActionResult<Project>> {
  return withUserAndRevalidate((user) => service.unarchiveProject(user, input));
}

export async function updatePortfolioFields(
  input: unknown
): Promise<ActionResult<{ projectId: string }>> {
  try {
    const user = await getCurrentUser();
    const result = await service.updatePortfolioFields(user, input);
    if (result.ok) {
      revalidatePath("/projects");
      revalidatePath(`/projects/${result.data.projectId}/settings`);
    }
    return result;
  } catch (err) {
    return fail(err);
  }
}

export async function inviteClient(
  input: unknown
): Promise<ActionResult<{ userId: string; existing: boolean }>> {
  try {
    const user = await getCurrentUser();
    const { inviteClientViewer } = await import("@/lib/portal/invite");
    const result = await inviteClientViewer(user, input);
    if (result.ok) revalidatePath("/projects", "layout");
    return result;
  } catch (err) {
    return fail(err);
  }
}

export async function updateBaselineSettings(
  input: unknown
): Promise<ActionResult<{ projectId: string }>> {
  try {
    const user = await getCurrentUser();
    const result = await (
      await import("@/lib/projects/baseline")
    ).updateBaselineSettings(user, input);
    if (result.ok) revalidatePath("/projects", "layout");
    return result;
  } catch (err) {
    return fail(err);
  }
}
