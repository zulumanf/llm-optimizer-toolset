/**
 * Operator standing preferences (spec 114): one durable block per
 * operator, rendered into the assistant's system prompt. Prompt context
 * only — nothing else reads it, so preferences can never override tiers,
 * gates, budgets, or validation by construction.
 */
import { z } from "zod";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { isStaff, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";

export const PREFERENCES_MAX = 2000;

function assertStaff(user: CurrentUser): void {
  if (!isStaff(user)) {
    throw new ClassifiedError("forbidden", "The assistant is staff-only.");
  }
}

export async function getPreferences(user: CurrentUser): Promise<string | null> {
  assertStaff(user);
  const [row] = await sql`
    select content from assistant_preferences where user_id = ${user.id}
  `;
  const content = (row?.content as string | undefined)?.trim();
  return content ? content : null;
}

/** Set (or, with empty content, clear) the caller's standing preferences. */
export async function setPreferences(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ cleared: boolean }>> {
  const parsed = z
    .object({ content: z.string().trim().max(PREFERENCES_MAX) })
    .safeParse(raw);
  if (!parsed.success) {
    return fail(
      new ClassifiedError("validation", `Preferences must be at most ${PREFERENCES_MAX} chars.`)
    );
  }
  const content = parsed.data.content;
  try {
    assertStaff(user);
    await sql.begin(async (tx) => {
      if (content.length === 0) {
        await tx`delete from assistant_preferences where user_id = ${user.id}`;
      } else {
        await tx`
          insert into assistant_preferences (user_id, content)
          values (${user.id}, ${content})
          on conflict (user_id) do update set content = ${content}, updated_at = now()
        `;
      }
      await writeAudit(tx, {
        userId: user.id,
        action: "assistant.preferences_set",
        entity: "assistant_preferences",
        entityId: user.id,
        detail: { cleared: content.length === 0, chars: content.length },
      });
    });
    return ok({ cleared: content.length === 0 });
  } catch (err) {
    return fail(err);
  }
}
