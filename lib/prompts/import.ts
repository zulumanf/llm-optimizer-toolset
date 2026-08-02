/**
 * Bulk prompt import service (spec 035) — the transactional half; parsing
 * lives in lib/prompts/import-parse.ts (pure). Dedupe is case- and
 * whitespace-insensitive against the set's active prompts and within the
 * batch; survivors insert with source='import'; one audit row carries the
 * counts. Zero valid rows is a failure, not an empty success.
 */
import { z } from "zod";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { listCompaniesForProject } from "@/db/companies";
import { assertCanWrite, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import {
  normalizePromptText,
  parsePromptImport,
  type RejectedRow,
} from "@/lib/prompts/import-parse";

const importSchema = z.object({
  setId: z.string().uuid(),
  content: z.string().min(1, "Nothing to import.").max(500_000),
});

export interface PromptImportResult {
  added: number;
  skippedDuplicates: number;
  rejected: RejectedRow[];
  format: "csv" | "lines";
}

export async function importPrompts(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<PromptImportResult>> {
  const parsed = importSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "A prompt set id and content are required."));
  }
  const { setId, content } = parsed.data;
  try {
    assertCanWrite(user);
    const result = await sql.begin(async (tx) => {
      const [set] = await tx`
        select project_id, archived_at from prompt_sets where id = ${setId}
      `;
      if (!set) throw new ClassifiedError("not_found", "Prompt set not found.");
      if (set.archivedAt) {
        throw new ClassifiedError("conflict", "Archived sets cannot be edited.");
      }

      const companies = await listCompaniesForProject(set.projectId as string);
      const brandNames = companies.flatMap((c) => [c.name, ...(c.aliases ?? [])]);

      const parse = parsePromptImport(content, { brandNames });
      if (parse.rows.length === 0) {
        throw new ClassifiedError(
          "validation",
          parse.rejected.length > 0
            ? `No importable rows — all ${parse.rejected.length} were rejected (first: ${parse.rejected[0]!.reason}).`
            : "No importable rows found."
        );
      }

      const existing = await tx`
        select text from prompts
        where prompt_set_id = ${setId} and archived_at is null
      `;
      const seen = new Set(existing.map((r) => normalizePromptText(r.text as string)));

      let added = 0;
      let skippedDuplicates = 0;
      for (const row of parse.rows) {
        const key = normalizePromptText(row.text);
        if (seen.has(key)) {
          skippedDuplicates += 1;
          continue;
        }
        seen.add(key);
        await tx`
          insert into prompts (prompt_set_id, text, category, language,
            position, tier, source)
          values (
            ${setId}, ${row.text}, ${row.category}, ${row.language},
            (select coalesce(max(position), 0) + 1 from prompts
              where prompt_set_id = ${setId} and archived_at is null),
            ${row.tier}, 'import'
          )
        `;
        added += 1;
      }

      await writeAudit(tx, {
        userId: user.id,
        action: "prompt.import",
        entity: "prompt_set",
        entityId: setId,
        detail: {
          added,
          skippedDuplicates,
          rejected: parse.rejected.length,
          format: parse.format,
          classifierVersion: parse.classifierVersion,
        },
      });

      return {
        added,
        skippedDuplicates,
        rejected: parse.rejected,
        format: parse.format,
      };
    });
    return ok(result);
  } catch (err) {
    return fail(err);
  }
}
