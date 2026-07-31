/**
 * Server-side page gates (spec 031). The cross-client staff surfaces
 * authenticated but never checked ROLE — a client login could read
 * portfolio names, costs, and exceptions. Segment layouts call
 * requireStaffPage() so every page under them is gated by construction;
 * a redirect, not a 403, because a client account landing on an internal
 * URL is a navigation accident, not an attack to report on.
 *
 * Pages-only module: redirect() throws outside a request context.
 */
import { redirect } from "next/navigation";
import { getCurrentUser, isStaff, type CurrentUser } from "@/lib/auth";

export async function requireStaffPage(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!isStaff(user)) redirect("/portal");
  return user;
}
