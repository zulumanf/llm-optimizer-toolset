/**
 * Client portal invites (spec 031 follow-up). Provisioning is the ONLY
 * legal path to a client login: the auth callback refuses any Supabase
 * account without a users row, so an invite is (1) create the auth user,
 * (2) create the users row as client_viewer, (3) grant exactly one
 * project. Admin-only — handing a client a login is an owner decision.
 *
 * Requires AUTH_MODE=supabase: under dev auth there is no identity
 * provider to invite into, and pretending otherwise would fabricate an
 * account no one can use.
 */
import { z } from "zod";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import {
  assertProjectAccess,
  assertRole,
  type CurrentUser,
} from "@/lib/auth";
import { getEnv } from "@/lib/env";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { firstZodMessage } from "@/lib/service-helpers";

const inviteSchema = z.object({
  projectId: z.string().uuid(),
  email: z.string().trim().toLowerCase().email(),
  name: z.string().trim().min(1).max(120),
});

export async function inviteClientViewer(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ userId: string; existing: boolean }>> {
  const parsed = inviteSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const input = parsed.data;
  try {
    assertRole(user, "admin");
    await assertProjectAccess(user, input.projectId);

    const [existingUser] = await sql`
      select id, role, active from users where lower(email) = ${input.email}
    `;
    if (existingUser && existingUser.role !== "client_viewer") {
      // Never silently downgrade or cross-purpose a staff account.
      return fail(
        new ClassifiedError(
          "conflict",
          "That email already belongs to a non-client account."
        )
      );
    }

    let userId: string;
    let existing = false;
    if (existingUser) {
      // Granting an existing client account needs no identity provider.
      userId = existingUser.id as string;
      existing = true;
    } else {
      if (getEnv().AUTH_MODE !== "supabase") {
        return fail(
          new ClassifiedError(
            "conflict",
            "Creating a client login needs AUTH_MODE=supabase — there is no identity provider to invite into under dev auth."
          )
        );
      }
      const { supabaseAdminClient } = await import("@/lib/supabase/server");
      const admin = supabaseAdminClient();
      const created = await admin.auth.admin.createUser({
        email: input.email,
        email_confirm: true,
      });
      if (created.error || !created.data.user) {
        return fail(
          new ClassifiedError(
            "internal",
            `Identity provider refused the invite: ${created.error?.message ?? "unknown"}`
          )
        );
      }
      userId = created.data.user.id;
      await sql`
        insert into users (id, email, name, role)
        values (${userId}, ${input.email}, ${input.name}, 'client_viewer')
        on conflict (id) do nothing
      `;
    }

    await sql.begin(async (tx) => {
      await tx`
        insert into user_project_access (user_id, project_id, granted_by)
        values (${userId}, ${input.projectId}, ${user.id})
        on conflict do nothing
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "portal.invite_client",
        entity: "user",
        entityId: userId,
        detail: { email: input.email, projectId: input.projectId, existing },
      });
    });
    return ok({ userId, existing });
  } catch (err) {
    return fail(err);
  }
}

/** Everyone with portal access to this project — for the settings view. */
export async function listPortalGrants(projectId: string): Promise<
  { userId: string; email: string; name: string; active: boolean }[]
> {
  const rows = await sql`
    select u.id, u.email, u.name, u.active
    from user_project_access a join users u on u.id = a.user_id
    where a.project_id = ${projectId} and u.role = 'client_viewer'
    order by u.email asc
  `;
  return rows.map((r) => ({
    userId: r.id as string,
    email: r.email as string,
    name: r.name as string,
    active: Boolean(r.active),
  }));
}

/**
 * Revoke a client's portal grant (spec 052, audit F29). Grants are access
 * control, not measurement data — deletable. The users row and any audit
 * history stay; only the door closes. Admin-only, audited.
 */
export async function revokeClientAccess(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ revoked: boolean }>> {
  const parsed = z
    .object({ userId: z.string().uuid(), projectId: z.string().uuid() })
    .safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const input = parsed.data;
  try {
    assertRole(user, "admin");
    await assertProjectAccess(user, input.projectId);
    const revoked = await sql.begin(async (tx) => {
      const rows = await tx`
        delete from user_project_access
        where user_id = ${input.userId} and project_id = ${input.projectId}
        returning user_id
      `;
      if (rows.length === 0) return false;
      await writeAudit(tx, {
        userId: user.id,
        action: "portal.access_revoked",
        entity: "user",
        entityId: input.userId,
        detail: { projectId: input.projectId },
      });
      return true;
    });
    if (!revoked) {
      return fail(new ClassifiedError("not_found", "No grant exists for that user and project."));
    }
    return ok({ revoked: true });
  } catch (err) {
    return fail(err);
  }
}

/**
 * Deactivate (or reactivate) a login. Auth reads users.active on every
 * request, so deactivation takes effect immediately — the column existed
 * and nothing in the product could ever set it (audit F29). Never self:
 * the last admin locking themselves out is not a recoverable state.
 */
export async function setUserActive(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ userId: string; active: boolean }>> {
  const parsed = z
    .object({ userId: z.string().uuid(), active: z.boolean() })
    .safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const input = parsed.data;
  try {
    assertRole(user, "admin");
    if (input.userId === user.id && !input.active) {
      return fail(
        new ClassifiedError("validation", "You cannot deactivate your own login.")
      );
    }
    await sql.begin(async (tx) => {
      const [row] = await tx`
        update users set active = ${input.active} where id = ${input.userId}
        returning id
      `;
      if (!row) throw new ClassifiedError("not_found", "User not found.");
      await writeAudit(tx, {
        userId: user.id,
        action: input.active ? "user.reactivated" : "user.deactivated",
        entity: "user",
        entityId: input.userId,
        detail: {},
      });
    });
    return ok({ userId: input.userId, active: input.active });
  } catch (err) {
    return fail(err);
  }
}
