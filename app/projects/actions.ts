"use server";

import { makeActionRunner } from "@/lib/actions/run";
import type { ActionResult } from "@/lib/actions/result";
import type { Project } from "@/db/projects";
import * as service from "@/lib/projects/service";

/**
 * Thin wrappers (docs/11). The project CRUD actions revalidate a
 * result-derived path (the created/updated project's own page), which is
 * why this file carried a private copy of the runner until the runner
 * learned dynamic targets (cleanup 2026-08-18).
 */
const runProject = makeActionRunner("/projects", (data) => [
  `/projects/${(data as Project).id}`,
]);
const runPortfolio = makeActionRunner("/projects", (data) => [
  `/projects/${(data as { projectId: string }).projectId}/settings`,
]);
const runLayout = makeActionRunner(["/projects", "layout"]);

export async function createProject(input: unknown): Promise<ActionResult<Project>> {
  return runProject((user) => service.createProject(user, input));
}

export async function updateProject(input: unknown): Promise<ActionResult<Project>> {
  return runProject((user) => service.updateProject(user, input));
}

export async function archiveProject(input: unknown): Promise<ActionResult<Project>> {
  return runProject((user) => service.archiveProject(user, input));
}

export async function unarchiveProject(input: unknown): Promise<ActionResult<Project>> {
  return runProject((user) => service.unarchiveProject(user, input));
}

export async function updatePortfolioFields(
  input: unknown
): Promise<ActionResult<{ projectId: string }>> {
  return runPortfolio((user) => service.updatePortfolioFields(user, input));
}

export async function revokeClientPortalAccess(
  input: unknown
): Promise<ActionResult<{ revoked: boolean }>> {
  return runLayout(async (user) => {
    const { revokeClientAccess } = await import("@/lib/portal/invite");
    return revokeClientAccess(user, input);
  });
}

export async function setClientUserActive(
  input: unknown
): Promise<ActionResult<{ userId: string; active: boolean }>> {
  return runLayout(async (user) => {
    const { setUserActive } = await import("@/lib/portal/invite");
    return setUserActive(user, input);
  });
}

export async function inviteClient(
  input: unknown
): Promise<ActionResult<{ userId: string; existing: boolean }>> {
  return runLayout(async (user) => {
    const { inviteClientViewer } = await import("@/lib/portal/invite");
    return inviteClientViewer(user, input);
  });
}

export async function updateBaselineSettings(
  input: unknown
): Promise<ActionResult<{ projectId: string }>> {
  return runLayout(async (user) => {
    const { updateBaselineSettings: update } = await import("@/lib/projects/baseline");
    return update(user, input);
  });
}

export async function proposeEntityRelationship(
  input: unknown
): Promise<ActionResult<{ relationshipId: string }>> {
  return runLayout(async (user) => {
    const { proposeRelationship } = await import("@/lib/knowledge/entities/service");
    return proposeRelationship(user, input);
  });
}

export async function reviewEntityRelationship(
  input: unknown
): Promise<ActionResult<{ relationshipId: string; status: string }>> {
  return runLayout(async (user) => {
    const { reviewRelationship } = await import("@/lib/knowledge/entities/service");
    return reviewRelationship(user, input);
  });
}
