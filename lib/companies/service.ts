/** Company registry (spec 004): canonical names, aliases, is_self. Alias
 * collisions are blocked — an alias may not equal another active company's
 * name or alias (case-insensitive). */
import { z } from "zod";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import type { Company } from "@/db/companies";
import { assertCanWrite, assertRole, type CurrentUser } from "@/lib/auth";
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
  /** Spec 056: scopes name uniqueness — two same-named firms may coexist
   * in different markets. Null = the global bucket (legacy default). */
  marketId: z.string().uuid().nullable().optional(),
});

const COLUMNS = sql`id, name, aliases, domain, is_self, market_id, merged_into,
  created_at, archived_at`;

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
    assertCanWrite(user);
    const company = await sql.begin(async (tx) => {
      if (input.isSelf !== undefined && input.id) {
        const [existing] = await tx`select is_self from companies where id = ${input.id}`;
        if (existing && existing.isSelf !== input.isSelf) {
          assertRole(user, "admin"); // changing is_self is admin-only (spec 004)
        }
      }

      // Alias collision check, scoped to the same market bucket (spec 056):
      // cross-market same names are legitimate different firms and reach
      // the resolver as a tie -> possible -> human (spec 050 contract).
      const terms = [input.name, ...aliases].map((t) => t.toLowerCase());
      const marketId = input.marketId ?? null;
      const conflicts = await tx`
        select name from companies
        where archived_at is null
          and coalesce(market_id, '00000000-0000-0000-0000-000000000000'::uuid)
            = coalesce(${marketId}::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
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
              is_self = coalesce(${input.isSelf ?? null}, is_self),
              market_id = coalesce(${marketId}::uuid, market_id)
            where id = ${input.id} and archived_at is null
            returning ${COLUMNS}
          `
        : await tx<Company[]>`
            insert into companies (name, aliases, domain, is_self, market_id)
            values (${input.name}, ${aliases}, ${input.domain ?? null},
              ${input.isSelf ?? false}, ${marketId})
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
          "Company not found, already archived, or is the platform's own brand (is_self cannot be archived)."
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

/** Follow merge chains to the current identity (spec 056). */
export async function resolveCompanyId(companyId: string): Promise<string> {
  let current = companyId;
  for (let hop = 0; hop < 10; hop += 1) {
    const [row] = await sql`select merged_into from companies where id = ${current}`;
    if (!row?.mergedInto) return current;
    current = row.mergedInto as string;
  }
  throw new ClassifiedError("internal", "Company merge chain exceeds 10 hops.");
}

/**
 * Merge one company into another (spec 056). Non-destructive by design:
 * the merged row archives with a pointer, its name and aliases move to the
 * survivor so future parsing credits it, prospects repoint, competitor
 * tracking re-tracks — and every historical mention/score stays exactly
 * where it was measured. Rewriting history onto the survivor would be
 * fabrication; continuity breaks at a merge and reports carry the sample
 * sizes that say so.
 */
export async function mergeCompanies(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ fromId: string; intoId: string; movedAliases: string[] }>> {
  const parsed = z
    .object({
      fromId: z.string().uuid(),
      intoId: z.string().uuid(),
      reason: z.string().trim().min(10, "A merge needs a written reason."),
    })
    .safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const input = parsed.data;
  try {
    assertRole(user, "admin");
    if (input.fromId === input.intoId) {
      return fail(new ClassifiedError("validation", "A company cannot merge into itself."));
    }
    const result = await sql.begin(async (tx) => {
      const [from] = await tx`
        select id, name, aliases, merged_into, archived_at from companies
        where id = ${input.fromId} for update
      `;
      const [into] = await tx`
        select id, name, aliases, merged_into, archived_at from companies
        where id = ${input.intoId} for update
      `;
      if (!from || !into) throw new ClassifiedError("not_found", "Company not found.");
      if (from.mergedInto || into.mergedInto || from.archivedAt || into.archivedAt) {
        throw new ClassifiedError(
          "conflict",
          "Both companies must be active and unmerged — chains resolve at read time, never at write time."
        );
      }
      // Two client subjects merging is two clients merging. Refuse.
      const subjects = await tx`
        select p.id from projects p
        where p.subject_company_id in (${input.fromId}, ${input.intoId})
          and p.kind = 'client' and p.status = 'active'
      `;
      if (subjects.length > 1) {
        throw new ClassifiedError(
          "conflict",
          "Both companies are active client subjects — merging them would merge two clients. Resolve the client structure first."
        );
      }

      const movedAliases = [
        from.name as string,
        ...((from.aliases as string[]) ?? []),
      ].filter(
        (a) =>
          a.toLowerCase() !== (into.name as string).toLowerCase() &&
          !((into.aliases as string[]) ?? []).some(
            (b) => b.toLowerCase() === a.toLowerCase()
          )
      );
      await tx`
        update companies
        set aliases = ${[...((into.aliases as string[]) ?? []), ...movedAliases]}
        where id = ${input.intoId}
      `;
      await tx`
        update companies
        set merged_into = ${input.intoId}, archived_at = now()
        where id = ${input.fromId}
      `;
      await tx`
        update prospects set company_id = ${input.intoId}, updated_at = now()
        where company_id = ${input.fromId}
      `;
      // Re-track competitor rows where the survivor is not already tracked.
      await tx`
        update competitors set company_id = ${input.intoId}
        where company_id = ${input.fromId}
          and not exists (
            select 1 from competitors c2
            where c2.project_id = competitors.project_id
              and c2.company_id = ${input.intoId}
          )
      `;
      await tx`
        delete from competitors where company_id = ${input.fromId}
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "company.merged",
        entity: "company",
        entityId: input.fromId,
        detail: { intoId: input.intoId, reason: input.reason, movedAliases },
      });
      return { fromId: input.fromId, intoId: input.intoId, movedAliases };
    });
    return ok(result);
  } catch (err) {
    return fail(err);
  }
}

/**
 * Reverse a merge (spec 056). Possible because the merge destroyed
 * nothing: the row un-archives and the exact aliases the merge audit row
 * recorded move back. Admin, reasoned, audited.
 */
export async function unmergeCompany(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ companyId: string; restoredAliases: string[] }>> {
  const parsed = z
    .object({
      companyId: z.string().uuid(),
      reason: z.string().trim().min(10, "An unmerge needs a written reason."),
    })
    .safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const input = parsed.data;
  try {
    assertRole(user, "admin");
    const result = await sql.begin(async (tx) => {
      const [from] = await tx`
        select id, merged_into from companies where id = ${input.companyId} for update
      `;
      if (!from) throw new ClassifiedError("not_found", "Company not found.");
      const intoId = from.mergedInto as string | null;
      if (!intoId) {
        throw new ClassifiedError("conflict", "This company is not merged.");
      }
      const [mergeAudit] = await tx`
        select detail from audit_log
        where action = 'company.merged' and entity_id = ${input.companyId}
        order by at desc limit 1
      `;
      const movedAliases =
        ((mergeAudit?.detail as { movedAliases?: string[] } | null)?.movedAliases ??
          []) as string[];
      // The merged row's own name goes back to being ITS name, not an alias.
      const [fromRow] = await tx`select name from companies where id = ${input.companyId}`;
      const aliasesToRestore = movedAliases.filter(
        (a) => a.toLowerCase() !== (fromRow?.name as string).toLowerCase()
      );
      const [into] = await tx`
        select aliases from companies where id = ${intoId} for update
      `;
      const lowered = new Set(movedAliases.map((a) => a.toLowerCase()));
      await tx`
        update companies
        set aliases = ${((into?.aliases as string[]) ?? []).filter(
          (a) => !lowered.has(a.toLowerCase())
        )}
        where id = ${intoId}
      `;
      await tx`
        update companies
        set merged_into = null, archived_at = null,
          aliases = ${aliasesToRestore.length > 0 ? aliasesToRestore : sql`aliases`}
        where id = ${input.companyId}
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "company.unmerged",
        entity: "company",
        entityId: input.companyId,
        detail: { fromInto: intoId, reason: input.reason, restoredAliases: aliasesToRestore },
      });
      return { companyId: input.companyId, restoredAliases: aliasesToRestore };
    });
    return ok(result);
  } catch (err) {
    return fail(err);
  }
}
