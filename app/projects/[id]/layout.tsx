import { notFound, redirect } from "next/navigation";
import {
  assertProjectAccess,
  getCurrentUser,
  isStaff,
  NotAuthenticatedError,
  ProjectAccessError,
} from "@/lib/auth";

/**
 * The project gate for every workspace page (spec 014, docs/10).
 *
 * Each `/projects/[id]/*` page reads client data through the id in the URL,
 * and none of them re-checked that the caller may see that client — the
 * audit found `visibleProjectIds` with zero call sites, which made project
 * isolation URL-parameter-shaped.
 *
 * This layout is NOT the boundary (spec 156): Next.js renders it and the page
 * concurrently, so a redirect()/notFound() here does not stop the page's data
 * from streaming. Every page calls requireProjectStaffPage() itself, first;
 * this check stays as defence in depth.
 *
 * Denial renders as 404, never 403 — confirming a project id exists is
 * itself a leak across clients. Staff pass untouched (visibleProjectIds
 * returns null for staff, and assertProjectAccess treats null as
 * unrestricted), so this adds one users-table read and, for client roles,
 * one grants read per request.
 *
 * This gates page rendering only. Server actions and download routes do not
 * pass through layouts and carry their own checks.
 */
export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  let staff = true;
  try {
    const user = await getCurrentUser();
    await assertProjectAccess(user, id);
    staff = isStaff(user);
  } catch (err) {
    if (err instanceof NotAuthenticatedError) redirect("/login");
    if (err instanceof ProjectAccessError) notFound();
    throw err;
  }
  // A granted client account still doesn't get the INTERNAL workspace —
  // costs, internal notes, settings live here. Their surface is the portal.
  if (!staff) redirect(`/portal/${id}`);
  return children;
}
