import { notFound, redirect } from "next/navigation";
import {
  assertProjectAccess,
  getCurrentUser,
  NotAuthenticatedError,
  ProjectAccessError,
  type CurrentUser,
} from "@/lib/auth";
import { getProject } from "@/db/projects";

/**
 * The portal page gate (specs 031/155): no session → /login, no grant → 404.
 *
 * Every portal layout calls this itself. Next.js renders nested layouts in
 * parallel, so a parent layout's notFound() does NOT stop a child layout
 * from rendering — a child that reads project data without its own gate
 * streams it to a client who has no grant.
 */
export async function portalGate(projectId: string): Promise<{ user: CurrentUser; project: NonNullable<Awaited<ReturnType<typeof getProject>>> }> {
  let user: CurrentUser;
  try {
    user = await getCurrentUser();
    await assertProjectAccess(user, projectId);
  } catch (err) {
    if (err instanceof NotAuthenticatedError) redirect("/login");
    if (err instanceof ProjectAccessError) notFound();
    throw err;
  }
  const project = await getProject(projectId);
  if (!project) notFound();
  return { user, project };
}
