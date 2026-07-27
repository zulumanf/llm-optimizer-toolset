/** Company registry (spec 004): canonical names, aliases, is_self. Alias
 * collisions are blocked — an alias may not equal another active company's
 * name or alias (case-insensitive). */
import { z } from "zod";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import type { Company } from "@/db/companies";
import { assertRole, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { firstZodMessage, duplicateNameConflict } from "@/lib/service-helpers";

const companySchema = z.object({
  id: z.string().uuid().optional(),
  name: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(1, "Name is required.").max(80)),
  aliases: z
    .array(z.string().transform((s) => s.trim()).pipe(z.string().min(1).max(80)))
    .max(20)
    .default([]),
  domain: z
    .string()
    .transform((s) => s.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, ""))
    .pipe(z.string().max(255))
    .optional(),
  isSelf: z.boolean().optional(),
});

const COLUMNS = sql`id, name, aliases, domain, is_self, created_at, archived_at`;

export async function upsertCompany(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<Company>> {
  const parsed = companySchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const input = parsed.data;
  const aliases = [...new Set(input.aliases.map((a) => a))].filter(
    (a) => a.toLowerCase() !== input.name.toLowerCase()
  );

  try {
    const company = await sql.begin(async (tx) => {
      if (input.isSelf !== undefined && input.id) {
        const [existing] = await tx`select is_self from companies where id = ${input.id}`;
        if (existing && existing.isSelf !== input.isSelf) {
          assertRole(user, "admin"); // changing is_self is admin-only (spec 004)
        }
      }

      // Alias collision check against every other active company (spec 004)
      const terms = [input.name, ...aliases].map((t) => t.toLowerCase());
      const conflicts = await tx`
        select name from companies
        where archived_at is null
          and (${input.id ?? null}::uuid is null or id != ${input.id ?? null})
          and (
            lower(name) = any(${terms}) or
            exists (
              select 1 from unnest(aliases) a where lower(a) = any(${terms})
            )
          )
      `;
      if (conflicts.length > 0) {
        throw new ClassifiedError(
          "conflict",
          `Name or alias collides with existing company "${conflicts[0]?.name}".`
        );
      }

      const [row] = input.id
        ? await tx<Company[]>`
            update companies set
              name = ${input.name},
              aliases = ${aliases},
              domain = ${input.domain ?? null},
              is_self = coalesce(${input.isSelf ?? null}, is_self)
            where id = ${input.id} and archived_at is null
            returning ${COLUMNS}
          `
        : await tx<Company[]>`
            insert into companies (name, aliases, domain, is_self)
            values (${input.name}, ${aliases}, ${input.domain ?? null},
              ${input.isSelf ?? false})
            returning ${COLUMNS}
          `;
      if (!row) throw new ClassifiedError("not_found", "Company not found.");
      await writeAudit(tx, {
        userId: user.id,
        action: "company.upsert",
        entity: "company",
        entityId: row.id,
        detail: { name: input.name, isSelf: row.isSelf },
      });
      return row;
    });
    return ok(company);
  } catch (err) {
    return fail(
      duplicateNameConflict(err, "A company with this name (or is_self) already exists.")
    );
  }
}

export async function archiveCompany(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<Company>> {
  const parsed = z.object({ id: z.string().uuid() }).safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "Invalid company id."));
  }
  try {
    assertRole(user, "admin");
    const company = await sql.begin(async (tx) => {
      const [row] = await tx<Company[]>`
        update companies set archived_at = now()
        where id = ${parsed.data.id} and archived_at is null and not is_self
        returning ${COLUMNS}
      `;
      if (!row) {
        throw new ClassifiedError(
          "conflict",
          "Company not found, already archived, or is Parva (is_self cannot be archived)."
        );
      }
      await writeAudit(tx, {
        userId: user.id,
        action: "company.archive",
        entity: "company",
        entityId: row.id,
      });
      return row;
    });
    return ok(company);
  } catch (err) {
    return fail(err);
  }
}
