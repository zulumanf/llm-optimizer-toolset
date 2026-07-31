/**
 * Weekly-baseline settings (spec 003 follow-up): the cron consumes
 * baseline_prompt_set_id + baseline_config on projects; this replaces the
 * set-it-via-SQL interim noted in that spec.
 */
import { z } from "zod";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { assertCanWrite, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { firstZodMessage } from "@/lib/service-helpers";
import {
  providerConfigSchema,
  BUDGET_MIN_USD,
  BUDGET_MAX_USD,
} from "@/lib/runs/validation";

const baselineSchema = z.object({
  projectId: z.string().uuid(),
  /** null disables the weekly baseline for this project */
  baselinePromptSetId: z.string().uuid().nullable(),
  providers: z.array(providerConfigSchema).min(1).optional(),
  budgetUsd: z.number().min(BUDGET_MIN_USD).max(BUDGET_MAX_USD).optional(),
});

export async function updateBaselineSettings(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ projectId: string }>> {
  const parsed = baselineSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const { projectId, baselinePromptSetId, providers, budgetUsd } = parsed.data;
  if (baselinePromptSetId && (!providers || budgetUsd === undefined)) {
    return fail(
      new ClassifiedError(
        "validation",
        "Enabling the baseline needs providers and a budget cap."
      )
    );
  }
  try {
    assertCanWrite(user);
    await sql.begin(async (tx) => {
      if (baselinePromptSetId) {
        const [set] = await tx`
          select project_id, archived_at from prompt_sets
          where id = ${baselinePromptSetId}
        `;
        if (!set) throw new ClassifiedError("not_found", "Prompt set not found.");
        if (set.projectId !== projectId) {
          throw new ClassifiedError("validation", "Set belongs to another project.");
        }
        if (set.archivedAt) {
          throw new ClassifiedError("conflict", "Set is archived.");
        }
        const [frozen] = await tx`
          select 1 from prompt_set_versions
          where prompt_set_id = ${baselinePromptSetId} limit 1
        `;
        if (!frozen) {
          throw new ClassifiedError(
            "conflict",
            "This set has never been frozen — the cron runs the latest frozen version."
          );
        }
      }
      const config = baselinePromptSetId
        ? { providers, budgetUsd }
        : null;
      const [row] = await tx`
        update projects set
          baseline_prompt_set_id = ${baselinePromptSetId},
          baseline_config = ${config ? tx.json(config as never) : null}
        where id = ${projectId} and status = 'active'
        returning id
      `;
      if (!row) {
        throw new ClassifiedError("conflict", "Project not found or archived.");
      }
      await writeAudit(tx, {
        userId: user.id,
        action: "project.baseline_settings",
        entity: "project",
        entityId: projectId,
        detail: {
          baselinePromptSetId,
          providers: (providers ?? null) as never,
          budgetUsd: budgetUsd ?? null,
        },
      });
    });
    return ok({ projectId });
  } catch (err) {
    return fail(err);
  }
}
