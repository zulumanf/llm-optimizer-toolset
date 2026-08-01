/**
 * Auth abstraction (spec 014).
 *
 * Two modes, one contract. `AUTH_MODE=dev` serves a single local user so the
 * app boots and the entire test suite runs with no identity provider
 * reachable — an explicit acceptance criterion, not a convenience. Anything
 * that needs a network login would make 900 tests depend on an inbox.
 *
 * `AUTH_MODE=supabase` reads the real session. The role comes from the `users`
 * table, never from the JWT: a token is a claim about identity, and letting it
 * also assert privilege means a compromised or stale token carries whatever
 * role it was minted with. One extra query buys revocation that takes effect
 * immediately.
 *
 * Role checks belong in services, never only in UI (docs/10).
 */
import { getEnv } from "@/lib/env";
import { ClassifiedError } from "@/lib/errors";
import { sql } from "@/db/client";

export const ROLES = [
  "admin",
  "operator",
  "reviewer",
  "client_viewer",
  "client_validator",
] as const;
export type Role = (typeof ROLES)[number];

/** Roles belonging to the agency rather than to a client. */
export const STAFF_ROLES: Role[] = ["admin", "operator", "reviewer"];

export function isStaff(user: { role: Role }): boolean {
  return STAFF_ROLES.includes(user.role);
}

export interface CurrentUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

/** Stable id so audit rows stay attributable across dev sessions. */
export const DEV_USER_ID = "00000000-0000-4000-8000-000000000001";

/** Thrown when there is no session. Callers redirect to /login. */
export class NotAuthenticatedError extends ClassifiedError {
  constructor(message = "Sign in to continue.") {
    super("forbidden", message);
    this.name = "NotAuthenticatedError";
  }
}

export async function getCurrentUser(): Promise<CurrentUser> {
  const env = getEnv();
  if (env.AUTH_MODE !== "supabase") {
    return {
      id: DEV_USER_ID,
      email: env.DEV_USER_EMAIL,
      name: env.DEV_USER_NAME,
      role: env.DEV_USER_ROLE,
    };
  }

  // Imported lazily so dev mode never loads the Supabase SDK, and so the
  // `server-only` guard cannot be tripped by a test importing this module.
  const { supabaseRouteClient } = await import("@/lib/supabase/server");
  const supabase = await supabaseRouteClient();

  // getUser() revalidates the token with Supabase. getSession() only decodes
  // the cookie, which a client can forge — never use it for authorisation.
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw new NotAuthenticatedError();

  const [row] = await sql`
    select id, email, name, role, active from users where id = ${data.user.id}
  `;

  if (!row) {
    // Authenticated by Supabase but unknown to this application. Refusing is
    // the safe default: anyone who can reach the Supabase project could
    // otherwise self-provision by signing in.
    throw new ClassifiedError(
      "forbidden",
      "This account is not provisioned for this workspace. An admin must add it."
    );
  }
  if (!row.active) {
    throw new ClassifiedError("forbidden", "This account has been deactivated.");
  }

  // Best-effort presence tracking; never fail a request over it.
  void sql`update users set last_seen_at = now() where id = ${row.id}`.catch(() => {});

  return {
    id: row.id as string,
    email: row.email as string,
    name: (row.name as string) || (data.user.email ?? ""),
    role: row.role as Role,
  };
}

/**
 * The platform's own principal for background work (migration 037).
 *
 * Worker handlers and engine node handlers act as this user rather than
 * calling getCurrentUser(): a worker has no request context, so under
 * AUTH_MODE=supabase that call throws on every job, and under dev it
 * silently attributed platform-initiated work to the dev admin. "Acted by
 * the platform" and "acted by a person" are different facts, and audit rows
 * should record which one happened.
 */
export const SYSTEM_USER_ID = "00000000-0000-4000-a000-000000000001";

export async function systemUser(): Promise<CurrentUser> {
  const [row] = await sql`
    select id, email, name, role from users
    where id = ${SYSTEM_USER_ID} and active
  `;
  if (!row) {
    throw new ClassifiedError(
      "internal",
      "The system user is missing — run database migrations (037_system_user)."
    );
  }
  return {
    id: row.id as string,
    email: row.email as string,
    name: row.name as string,
    role: row.role as Role,
  };
}

/** Null instead of throwing — for layouts deciding what to render. */
export async function getCurrentUserOrNull(): Promise<CurrentUser | null> {
  try {
    return await getCurrentUser();
  } catch {
    return null;
  }
}

/**
 * Assert a minimum privilege. Kept backward-compatible: every existing call
 * site passes "admin", and those keep meaning exactly what they meant.
 */
export function assertRole(user: CurrentUser, role: Role): void {
  if (role === "admin" && user.role !== "admin") {
    throw new ClassifiedError("forbidden", "This action requires the admin role.");
  }
  if (role === "operator" && !isStaff(user)) {
    throw new ClassifiedError("forbidden", "This action requires a staff role.");
  }
}

/**
 * Any write at all. Client accounts are read-only, and this is the single
 * place that says so — a check spread across twenty services is a check that
 * will be missing from the twenty-first.
 */
export function assertCanWrite(user: CurrentUser): void {
  if (!isStaff(user)) {
    throw new ClassifiedError(
      "forbidden",
      "This account has read-only access and cannot modify client data."
    );
  }
}

/**
 * Which clients this user may see. `null` means "every project" — the answer
 * for staff — and callers must treat null as unrestricted rather than empty.
 * Returning an explicit list for staff would silently drop a newly created
 * project until someone remembered to grant it.
 */
export async function visibleProjectIds(user: CurrentUser): Promise<string[] | null> {
  if (isStaff(user)) return null;
  const rows = await sql`
    select project_id from user_project_access where user_id = ${user.id}
  `;
  return rows.map((row) => row.projectId as string);
}

/**
 * Thrown when a user references a project outside their grant. Classified as
 * `not_found`, not `forbidden`: telling a client account that a project id
 * exists but is off-limits confirms another client's existence.
 */
export class ProjectAccessError extends ClassifiedError {
  constructor() {
    super("not_found", "Project not found.");
    this.name = "ProjectAccessError";
  }
}

/**
 * The project gate. Staff see every project; client accounts see exactly
 * their `user_project_access` grants. Call this wherever a request names a
 * project — pages via the `/projects/[id]` layout, download routes, and any
 * action that resolves data through a project id.
 */
export async function assertProjectAccess(
  user: CurrentUser,
  projectId: string
): Promise<void> {
  const visible = await visibleProjectIds(user);
  if (visible === null) return; // staff — unrestricted by design
  if (!visible.includes(projectId)) throw new ProjectAccessError();
}
