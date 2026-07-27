/**
 * Auth abstraction. AUTH_MODE=dev serves a single local user until a
 * Supabase project exists — see DECISIONS.md (2026-07-27, dev-mode auth).
 * Role checks belong in services, never only in UI (docs/10).
 */
import { getEnv } from "@/lib/env";
import { ClassifiedError } from "@/lib/errors";

export type Role = "admin" | "operator";

export interface CurrentUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

// Stable id so audit rows stay attributable across dev sessions.
const DEV_USER_ID = "00000000-0000-4000-8000-000000000001";

export async function getCurrentUser(): Promise<CurrentUser> {
  const env = getEnv();
  if (env.AUTH_MODE === "supabase") {
    throw new ClassifiedError(
      "internal",
      "AUTH_MODE=supabase is not implemented yet — deferred until a Supabase project exists (DECISIONS.md)."
    );
  }
  return {
    id: DEV_USER_ID,
    email: env.DEV_USER_EMAIL,
    name: env.DEV_USER_NAME,
    role: env.DEV_USER_ROLE,
  };
}

export function assertRole(user: CurrentUser, role: Role): void {
  if (role === "admin" && user.role !== "admin") {
    throw new ClassifiedError("forbidden", "This action requires the admin role.");
  }
}
