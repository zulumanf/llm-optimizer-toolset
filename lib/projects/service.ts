/**
 * Project business logic (spec 001). Server actions wrap these with
 * getCurrentUser + revalidatePath; integration tests call them directly.
 * Every mutation runs in a transaction with its audit row (docs/10).
 */
import { z } from "zod";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import type { Project } from "@/db/projects";
import { assertCanWrite, assertRole, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import {
  createProjectSchema,
  updateProjectSchema,
  projectIdSchema,
} from "@/lib/projects/validation";
import { firstZodMessage, duplicateNameConflict } from "@/lib/service-helpers";

export async function createProject(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<Project>> {
  const parsed = createProjectSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const { name, description } = parsed.data;
  try {
    assertCanWrite(user);
    const project = await sql.begin(async (tx) => {
      const [row] = await tx<Project[]>`
        insert into projects (name, description)
        values (${name}, ${description ?? null})
        returning id, name, description, status, created_at, archived_at
      `;
      if (!row) throw new ClassifiedError("internal", "Insert returned no row.");
      await writeAudit(tx, {
        userId: user.id,
        action: "project.create",
        entity: "project",
        entityId: row.id,
        detail: { name },
      });
      return row;
    });
    return ok(project);
  } catch (err) {
    return fail(duplicateNameConflict(err, "A project with this name already exists."));
  }
}

const portfolioFieldsSchema = z.object({
  projectId: z.string().uuid(),
  // null clears; absent leaves untouched
  accountOwnerId: z.string().uuid().nullable().optional(),
  serviceTier: z.enum(["standard", "premium", "exclusive"]).nullable().optional(),
  /** Annual contract value (plan 5.7): the control tower's commercial
   * weighting uses this instead of the provider-spend proxy when set. */
  contractValueUsd: z.number().nonnegative().nullable().optional(),
});

/** Portfolio operations fields (spec 030): who runs this account, at what
 * tier. Kept apart from updateProject so the name/description flow keeps
 * its shape. */
export async function updatePortfolioFields(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ projectId: string }>> {
  const parsed = portfolioFieldsSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const input = parsed.data;
  try {
    assertCanWrite(user);
    await sql.begin(async (tx) => {
      const [project] = await tx`
        select account_owner_id, service_tier, contract_value_usd from projects
        where id = ${input.projectId} for update
      `;
      if (!project) throw new ClassifiedError("not_found", "Project not found.");
      if (input.accountOwnerId != null) {
        const [owner] = await tx`
          select 1 from users where id = ${input.accountOwnerId} and active
        `;
        if (!owner) {
          throw new ClassifiedError("not_found", "Owner is not an active user.");
        }
      }
      await tx`
        update projects set
          account_owner_id = ${
            input.accountOwnerId !== undefined
              ? input.accountOwnerId
              : (project.accountOwnerId as string | null)
          },
          service_tier = ${
            input.serviceTier !== undefined
              ? input.serviceTier
              : (project.serviceTier as string | null)
          },
          contract_value_usd = ${
            input.contractValueUsd !== undefined
              ? input.contractValueUsd
              : (project.contractValueUsd as number | null)
          }
        where id = ${input.projectId}
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "project.update_portfolio_fields",
        entity: "project",
        entityId: input.projectId,
        detail: {
          accountOwnerId: input.accountOwnerId,
          serviceTier: input.serviceTier,
          contractValueUsd: input.contractValueUsd,
        },
      });
    });
    return ok({ projectId: input.projectId });
  } catch (err) {
    return fail(err);
  }
}

export async function updateProject(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<Project>> {
  const parsed = updateProjectSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const { id, name, description } = parsed.data;
  if (name === undefined && description === undefined) {
    return fail(new ClassifiedError("validation", "Nothing to update."));
  }
  try {
    assertCanWrite(user);
    const project = await sql.begin(async (tx) => {
      // Edits to archived projects are blocked except unarchive (spec 001)
      const [row] = await tx<Project[]>`
        update projects set
          name = coalesce(${name ?? null}, name),
          description = coalesce(${description ?? null}, description)
        where id = ${id} and status = 'active'
        returning id, name, description, status, created_at, archived_at
      `;
      if (!row) {
        const [existing] = await tx`select status from projects where id = ${id}`;
        throw existing
          ? new ClassifiedError("conflict", "Archived projects cannot be edited.")
          : new ClassifiedError("not_found", "Project not found.");
      }
      await writeAudit(tx, {
        userId: user.id,
        action: "project.update",
        entity: "project",
        entityId: id,
        detail: { name: name ?? null, description: description ?? null },
      });
      return row;
    });
    return ok(project);
  } catch (err) {
    return fail(duplicateNameConflict(err, "A project with this name already exists."));
  }
}

export async function archiveProject(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<Project>> {
  return setProjectStatus(user, raw, "archived");
}

export async function unarchiveProject(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<Project>> {
  return setProjectStatus(user, raw, "active");
}

async function setProjectStatus(
  user: CurrentUser,
  raw: unknown,
  target: "archived" | "active"
): Promise<ActionResult<Project>> {
  const parsed = projectIdSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "Invalid project id."));
  }
  const { id } = parsed.data;
  try {
    assertRole(user, "admin");
    const from = target === "archived" ? "active" : "archived";
    const project = await sql.begin(async (tx) => {
      const [row] = await tx<Project[]>`
        update projects set
          status = ${target},
          archived_at = ${target === "archived" ? sql`now()` : null}
        where id = ${id} and status = ${from}
        returning id, name, description, status, created_at, archived_at
      `;
      if (!row) {
        const [existing] = await tx`select status from projects where id = ${id}`;
        throw existing
          ? new ClassifiedError("conflict", `Project is not ${from}.`)
          : new ClassifiedError("not_found", "Project not found.");
      }
      await writeAudit(tx, {
        userId: user.id,
        action: target === "archived" ? "project.archive" : "project.unarchive",
        entity: "project",
        entityId: id,
      });
      return row;
    });
    return ok(project);
  } catch (err) {
    // Unarchive can collide with an active project's name (partial unique index)
    return fail(
      target === "active"
        ? duplicateNameConflict(err, "An active project already uses this name — rename it first.")
        : err
    );
  }
}
