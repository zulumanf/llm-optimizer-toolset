/**
 * Prompt-set business logic (spec 002): create/update/archive, freeze into
 * immutable versions, duplicate. Freeze is the reproducibility cornerstone —
 * see docs/07 step 2.
 */
import { sql, type TransactionSql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import type { PromptSet } from "@/db/prompt-sets";
import { assertCanWrite, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { isSameContent } from "@/lib/prompts/freeze";
import type { FrozenPrompt } from "@/lib/prompts/types";
import {
  createSetSchema,
  updateSetSchema,
  setIdSchema,
  duplicateSetSchema,
} from "@/lib/prompts/validation";
import { firstZodMessage, duplicateNameConflict } from "@/lib/service-helpers";

const SET_COLUMNS = sql`id, project_id, name, description, created_at, archived_at`;

export async function createPromptSet(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<PromptSet>> {
  const parsed = createSetSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const { projectId, name, description } = parsed.data;
  try {
    assertCanWrite(user);
    const set = await sql.begin(async (tx) => {
      const [project] = await tx`
        select status from projects where id = ${projectId}
      `;
      if (!project) throw new ClassifiedError("not_found", "Project not found.");
      if (project.status !== "active") {
        throw new ClassifiedError("conflict", "Project is archived.");
      }
      const [row] = await tx<PromptSet[]>`
        insert into prompt_sets (project_id, name, description)
        values (${projectId}, ${name}, ${description ?? null})
        returning ${SET_COLUMNS}
      `;
      if (!row) throw new ClassifiedError("internal", "Insert returned no row.");
      await writeAudit(tx, {
        userId: user.id,
        action: "prompt_set.create",
        entity: "prompt_set",
        entityId: row.id,
        detail: { name, projectId },
      });
      return row;
    });
    return ok(set);
  } catch (err) {
    return fail(duplicateNameConflict(err, "A prompt set with this name already exists in this project."));
  }
}

export async function updatePromptSet(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<PromptSet>> {
  const parsed = updateSetSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const { id, name, description } = parsed.data;
  try {
    assertCanWrite(user);
    const set = await sql.begin(async (tx) => {
      const [row] = await tx<PromptSet[]>`
        update prompt_sets set
          name = coalesce(${name ?? null}, name),
          description = coalesce(${description ?? null}, description)
        where id = ${id} and archived_at is null
        returning ${SET_COLUMNS}
      `;
      if (!row) throw await missingSetError(tx, id);
      await writeAudit(tx, {
        userId: user.id,
        action: "prompt_set.update",
        entity: "prompt_set",
        entityId: id,
        detail: { name: name ?? null },
      });
      return row;
    });
    return ok(set);
  } catch (err) {
    return fail(duplicateNameConflict(err, "A prompt set with this name already exists in this project."));
  }
}

export async function archivePromptSet(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<PromptSet>> {
  const parsed = setIdSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "Invalid prompt set id."));
  }
  try {
    assertCanWrite(user);
    const set = await sql.begin(async (tx) => {
      const [row] = await tx<PromptSet[]>`
        update prompt_sets set archived_at = now()
        where id = ${parsed.data.id} and archived_at is null
        returning ${SET_COLUMNS}
      `;
      if (!row) throw await missingSetError(tx, parsed.data.id);
      await writeAudit(tx, {
        userId: user.id,
        action: "prompt_set.archive",
        entity: "prompt_set",
        entityId: row.id,
      });
      return row;
    });
    return ok(set);
  } catch (err) {
    return fail(err);
  }
}

/**
 * Freeze the set's current active prompts into an immutable version
 * (docs/07 step 2). Locks the set row so concurrent freezes serialize;
 * the loser then fails the no-change check.
 */
export async function freezePromptSet(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ setId: string; version: number }>> {
  const parsed = setIdSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "Invalid prompt set id."));
  }
  const setId = parsed.data.id;
  try {
    assertCanWrite(user);
    const result = await sql.begin(async (tx) => {
      const [set] = await tx<PromptSet[]>`
        select ${SET_COLUMNS} from prompt_sets
        where id = ${setId} for update
      `;
      if (!set) throw new ClassifiedError("not_found", "Prompt set not found.");
      if (set.archivedAt) {
        throw new ClassifiedError("conflict", "Archived sets cannot be frozen.");
      }

      const prompts = await tx`
        select id, text, category, language, position, is_holdout from prompts
        where prompt_set_id = ${setId} and archived_at is null
        order by position asc, created_at asc
      `;
      if (prompts.length === 0) {
        throw new ClassifiedError("validation", "Cannot freeze an empty set.");
      }
      const snapshot: FrozenPrompt[] = prompts.map((p, i) => ({
        promptId: p.id as string,
        text: p.text as string,
        category: p.category as FrozenPrompt["category"],
        language: p.language as string,
        position: i + 1,
        isHoldout: Boolean(p.isHoldout),
      }));

      const [latest] = await tx`
        select version, frozen_prompts from prompt_set_versions
        where prompt_set_id = ${setId}
        order by version desc limit 1
      `;
      if (
        latest &&
        isSameContent(latest.frozenPrompts as FrozenPrompt[], snapshot)
      ) {
        throw new ClassifiedError(
          "conflict",
          `No changes since version ${latest.version} — nothing to freeze.`
        );
      }

      const version = latest ? (latest.version as number) + 1 : 1;
      await tx`
        insert into prompt_set_versions
          (prompt_set_id, version, frozen_prompts, frozen_by)
        values (${setId}, ${version}, ${tx.json(
          snapshot as unknown as Parameters<typeof tx.json>[0]
        )}, ${user.id})
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "prompt_set.freeze",
        entity: "prompt_set",
        entityId: setId,
        detail: { version, promptCount: snapshot.length },
      });
      return { setId, version };
    });
    return ok(result);
  } catch (err) {
    return fail(err);
  }
}

/** Duplicate a set from its live prompts, or seed a new set from a frozen version. */
export async function duplicatePromptSet(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<PromptSet>> {
  const parsed = duplicateSetSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const { setId, versionId, newName } = parsed.data;
  try {
    assertCanWrite(user);
    const set = await sql.begin(async (tx) => {
      let sourceSetId: string;
      let entries: { text: string; category: string; language: string }[];

      if (versionId) {
        const [version] = await tx`
          select prompt_set_id, frozen_prompts from prompt_set_versions
          where id = ${versionId}
        `;
        if (!version) throw new ClassifiedError("not_found", "Version not found.");
        sourceSetId = version.promptSetId as string;
        entries = (version.frozenPrompts as FrozenPrompt[])
          .sort((a, b) => a.position - b.position)
          .map(({ text, category, language }) => ({ text, category, language }));
      } else {
        sourceSetId = setId as string;
        entries = await tx`
          select text, category, language from prompts
          where prompt_set_id = ${sourceSetId} and archived_at is null
          order by position asc, created_at asc
        `;
      }

      const [source] = await tx`
        select project_id from prompt_sets where id = ${sourceSetId}
      `;
      if (!source) throw new ClassifiedError("not_found", "Prompt set not found.");

      const [row] = await tx<PromptSet[]>`
        insert into prompt_sets (project_id, name)
        values (${source.projectId}, ${newName})
        returning ${SET_COLUMNS}
      `;
      if (!row) throw new ClassifiedError("internal", "Insert returned no row.");

      for (const [i, e] of entries.entries()) {
        await tx`
          insert into prompts (prompt_set_id, text, category, language, position)
          values (${row.id}, ${e.text}, ${e.category}, ${e.language}, ${i + 1})
        `;
      }
      await writeAudit(tx, {
        userId: user.id,
        action: "prompt_set.duplicate",
        entity: "prompt_set",
        entityId: row.id,
        detail: { from: versionId ?? setId ?? null, promptCount: entries.length },
      });
      return row;
    });
    return ok(set);
  } catch (err) {
    return fail(duplicateNameConflict(err, "A prompt set with this name already exists in this project."));
  }
}

async function missingSetError(
  tx: TransactionSql,
  id: string
): Promise<ClassifiedError> {
  const [existing] = await tx`select id from prompt_sets where id = ${id}`;
  return existing
    ? new ClassifiedError("conflict", "Archived sets cannot be edited.")
    : new ClassifiedError("not_found", "Prompt set not found.");
}
