/**
 * Server-side page gates (specs 031, 156).
 *
 * EVERY internal page awaits one of these as its first statement. A gate in
 * a layout is not enough: Next.js renders a route's layouts and page
 * concurrently, so when a layout throws redirect()/notFound() the page has
 * still rendered and its data is still streamed in the response (spec 156 —
 * a client account read other clients' projects through /projects/<id>/*
 * and /work while the browser showed a 404 or a redirect). Layouts keep
 * their checks as defence in depth; tests/unit/page-gates-static.test.ts
 * fails any page that does not gate itself.
 *
 * A client account landing on an internal URL is redirected, not 403'd: it
 * is a navigation accident, not an attack to report on. A project the caller
 * may not see is a 404 — confirming the id exists is itself a leak.
 *
 * Pages-only module: redirect()/notFound() throw outside a request context.
 */
import { notFound, redirect } from "next/navigation";
import {
  assertProjectAccess,
  getCurrentUser,
  isStaff,
  NotAuthenticatedError,
  ProjectAccessError,
  type CurrentUser,
} from "@/lib/auth";

export async function requireStaffPage(): Promise<CurrentUser> {
  let user: CurrentUser;
  try {
    user = await getCurrentUser();
  } catch (err) {
    if (err instanceof NotAuthenticatedError) redirect("/login");
    throw err;
  }
  if (!isStaff(user)) redirect("/portal");
  return user;
}

/** The internal workspace for one project: granted AND staff. */
export async function requireProjectStaffPage(projectId: string): Promise<CurrentUser> {
  let user: CurrentUser;
  try {
    user = await getCurrentUser();
    await assertProjectAccess(user, projectId);
  } catch (err) {
    if (err instanceof NotAuthenticatedError) redirect("/login");
    if (err instanceof ProjectAccessError) notFound();
    throw err;
  }
  if (!isStaff(user)) redirect(`/portal/${projectId}`);
  return user;
}
