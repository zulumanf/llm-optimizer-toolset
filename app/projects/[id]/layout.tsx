import { notFound, redirect } from "next/navigation";
import {
  assertProjectAccess,
  getCurrentUser,
  NotAuthenticatedError,
  ProjectAccessError,
} from "@/lib/auth";

/**
 * The project gate for every workspace page (spec 014, docs/10).
 *
 * Each `/projects/[id]/*` page reads client data through the id in the URL,
 * and none of them re-checked that the caller may see that client — the
 * audit found `visibleProjectIds` with zero call sites, which made project
 * isolation URL-parameter-shaped. This layout is the choke point: one check,
 * inherited by every section, impossible for a new page to forget.
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
  try {
    const user = await getCurrentUser();
    await assertProjectAccess(user, id);
  } catch (err) {
    if (err instanceof NotAuthenticatedError) redirect("/login");
    if (err instanceof ProjectAccessError) notFound();
    throw err;
  }
  return children;
}
