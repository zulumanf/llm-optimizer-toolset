/**
 * Prompt-level business logic (spec 002): add/update/archive/reorder within
 * an active set. Frozen versions are unaffected by any of this — they
 * snapshot content at freeze time.
 */
import { sql, type TransactionSql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import type { Prompt } from "@/db/prompt-sets";
import type { CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import {
  addPromptSchema,
  updatePromptSchema,
  promptIdSchema,
  reorderSchema,
} from "@/lib/prompts/validation";
import { firstZodMessage } from "@/lib/service-helpers";

const PROMPT_COLUMNS = sql`id, prompt_set_id, text, category, language,
  position, created_at, archived_at`;

async function requireActiveSet(tx: TransactionSql, setId: string): Promise<void> {
  const [set] = await tx`
    select archived_at from prompt_sets where id = ${setId}
  `;
  if (!set) throw new ClassifiedError("not_found", "Prompt set not found.");
  if (set.archivedAt) {
    throw new ClassifiedError("conflict", "Archived sets cannot be edited.");
  }
}

export async function addPrompt(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<Prompt>> {
  const parsed = addPromptSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const { setId, text, category, language } = parsed.data;
  try {
    const prompt = await sql.begin(async (tx) => {
      await requireActiveSet(tx, setId);
      const [row] = await tx<Prompt[]>`
        insert into prompts (prompt_set_id, text, category, language, position)
        values (
          ${setId}, ${text}, ${category}, ${language ?? "en"},
          (select coalesce(max(position), 0) + 1 from prompts
            where prompt_set_id = ${setId} and archived_at is null)
        )
        returning ${PROMPT_COLUMNS}
      `;
      if (!row) throw new ClassifiedError("internal", "Insert returned no row.");
      await writeAudit(tx, {
        userId: user.id,
        action: "prompt.add",
        entity: "prompt",
        entityId: row.id,
        detail: { setId, category },
      });
      return row;
    });
    return ok(prompt);
  } catch (err) {
    return fail(err);
  }
}

export async function updatePrompt(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<Prompt>> {
  const parsed = updatePromptSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const { promptId, text, category, language } = parsed.data;
  try {
    const prompt = await sql.begin(async (tx) => {
      const [existing] = await tx`
        select prompt_set_id, archived_at from prompts where id = ${promptId}
      `;
      if (!existing) throw new ClassifiedError("not_found", "Prompt not found.");
      if (existing.archivedAt) {
        throw new ClassifiedError("conflict", "Archived prompts cannot be edited.");
      }
      await requireActiveSet(tx, existing.promptSetId as string);
      const [row] = await tx<Prompt[]>`
        update prompts set
          text = coalesce(${text ?? null}, text),
          category = coalesce(${category ?? null}, category),
          language = coalesce(${language ?? null}, language)
        where id = ${promptId}
        returning ${PROMPT_COLUMNS}
      `;
      if (!row) throw new ClassifiedError("internal", "Update returned no row.");
      await writeAudit(tx, {
        userId: user.id,
        action: "prompt.update",
        entity: "prompt",
        entityId: promptId,
      });
      return row;
    });
    return ok(prompt);
  } catch (err) {
    return fail(err);
  }
}

export async function archivePrompt(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<Prompt>> {
  const parsed = promptIdSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "Invalid prompt id."));
  }
  try {
    const prompt = await sql.begin(async (tx) => {
      const [existing] = await tx`
        select prompt_set_id from prompts
        where id = ${parsed.data.promptId} and archived_at is null
      `;
      if (!existing) throw new ClassifiedError("not_found", "Prompt not found.");
      await requireActiveSet(tx, existing.promptSetId as string);
      const [row] = await tx<Prompt[]>`
        update prompts set archived_at = now()
        where id = ${parsed.data.promptId}
        returning ${PROMPT_COLUMNS}
      `;
      if (!row) throw new ClassifiedError("internal", "Update returned no row.");
      await writeAudit(tx, {
        userId: user.id,
        action: "prompt.archive",
        entity: "prompt",
        entityId: row.id,
        detail: { setId: row.promptSetId },
      });
      return row;
    });
    return ok(prompt);
  } catch (err) {
    return fail(err);
  }
}

/**
 * Reorder must name exactly the set's active prompts — anything else means
 * the caller's view is stale (spec 002 validation rules).
 */
export async function reorderPrompts(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ setId: string }>> {
  const parsed = reorderSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const { setId, orderedPromptIds } = parsed.data;
  try {
    const result = await sql.begin(async (tx) => {
      await requireActiveSet(tx, setId);
      const activeRows = await tx`
        select id from prompts
        where prompt_set_id = ${setId} and archived_at is null
      `;
      const activeIds = new Set(activeRows.map((r) => r.id as string));
      const submitted = new Set(orderedPromptIds);
      const exactMatch =
        activeIds.size === submitted.size &&
        orderedPromptIds.every((id) => activeIds.has(id)) &&
        submitted.size === orderedPromptIds.length;
      if (!exactMatch) {
        throw new ClassifiedError(
          "conflict",
          "The prompt list changed — reload and try reordering again."
        );
      }
      for (const [i, id] of orderedPromptIds.entries()) {
        await tx`update prompts set position = ${i + 1} where id = ${id}`;
      }
      await writeAudit(tx, {
        userId: user.id,
        action: "prompt.reorder",
        entity: "prompt_set",
        entityId: setId,
        detail: { order: orderedPromptIds },
      });
      return { setId };
    });
    return ok(result);
  } catch (err) {
    return fail(err);
  }
}
