/**
 * Run lifecycle (spec 003): start, estimate, retry-failed, cancel. Execution
 * itself lives in lib/runs/execute.ts and runs in the worker. One code path
 * serves manual and scheduled runs (docs/02).
 */
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { enqueueJob } from "@/db/jobs";
import type { Run } from "@/db/runs";
import type { CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { firstZodMessage } from "@/lib/service-helpers";
import { estimateRun, type RunEstimate } from "@/lib/runs/cells";
import type { FrozenPrompt } from "@/lib/prompts/types";
import {
  startRunSchema,
  estimateRunSchema,
  runIdSchema,
} from "@/lib/runs/validation";

const RUN_COLUMNS = sql`id, project_id, prompt_set_version_id, label, providers,
  status, status_detail, trigger, started_by, budget_usd, cost_usd,
  started_at, completed_at`;

export async function startRun(
  user: CurrentUser | null,
  raw: unknown,
  trigger: "manual" | "scheduled" = "manual"
): Promise<ActionResult<Run>> {
  const parsed = startRunSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const input = parsed.data;
  try {
    const run = await sql.begin(async (tx) => {
      const [version] = await tx`
        select v.id, s.project_id, p.status as project_status
        from prompt_set_versions v
        join prompt_sets s on s.id = v.prompt_set_id
        join projects p on p.id = s.project_id
        where v.id = ${input.promptSetVersionId}
      `;
      if (!version) {
        throw new ClassifiedError("not_found", "Prompt set version not found.");
      }
      if (version.projectId !== input.projectId) {
        throw new ClassifiedError(
          "validation",
          "Version does not belong to this project."
        );
      }
      if (version.projectStatus !== "active") {
        throw new ClassifiedError("conflict", "Project is archived.");
      }

      const [row] = await tx<Run[]>`
        insert into runs
          (project_id, prompt_set_version_id, label, providers, trigger,
           started_by, budget_usd)
        values
          (${input.projectId}, ${input.promptSetVersionId}, ${input.label},
           ${tx.json(input.providers as never)}, ${trigger},
           ${user?.id ?? null}, ${input.budgetUsd})
        returning ${RUN_COLUMNS}
      `;
      if (!row) throw new ClassifiedError("internal", "Insert returned no row.");
      await enqueueJob(tx, "execute_run", { runId: row.id });
      await writeAudit(tx, {
        userId: user?.id ?? null,
        action: "run.start",
        entity: "run",
        entityId: row.id,
        detail: { label: input.label, trigger, budgetUsd: input.budgetUsd },
      });
      return row;
    });
    return ok(run);
  } catch (err) {
    return fail(err);
  }
}

export async function estimateRunForVersion(
  raw: unknown
): Promise<ActionResult<RunEstimate>> {
  const parsed = estimateRunSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  try {
    const [version] = await sql`
      select frozen_prompts from prompt_set_versions
      where id = ${parsed.data.promptSetVersionId}
    `;
    if (!version) {
      return fail(new ClassifiedError("not_found", "Prompt set version not found."));
    }
    return ok(
      estimateRun(version.frozenPrompts as FrozenPrompt[], parsed.data.providers)
    );
  } catch (err) {
    return fail(err);
  }
}

/** Re-attempts only failed/missing cells, appending to the same run (docs/07). */
export async function retryFailedCells(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ runId: string }>> {
  const parsed = runIdSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "Invalid run id."));
  }
  const { runId } = parsed.data;
  try {
    await sql.begin(async (tx) => {
      const [run] = await tx`select status from runs where id = ${runId} for update`;
      if (!run) throw new ClassifiedError("not_found", "Run not found.");
      if (!["partial", "completed", "failed"].includes(run.status as string)) {
        throw new ClassifiedError("conflict", "Run is still executing.");
      }
      await tx`
        update runs set status = 'pending', status_detail = null, completed_at = null
        where id = ${runId}
      `;
      await enqueueJob(tx, "execute_run", { runId });
      await writeAudit(tx, {
        userId: user.id,
        action: "run.retry_failed",
        entity: "run",
        entityId: runId,
      });
    });
    return ok({ runId });
  } catch (err) {
    return fail(err);
  }
}

export async function cancelRun(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ runId: string }>> {
  const parsed = runIdSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "Invalid run id."));
  }
  const { runId } = parsed.data;
  try {
    await sql.begin(async (tx) => {
      const [row] = await tx`
        update runs set status = 'partial', status_detail = 'cancelled'
        where id = ${runId} and status in ('pending', 'running')
        returning id
      `;
      if (!row) {
        const [exists] = await tx`select id from runs where id = ${runId}`;
        throw exists
          ? new ClassifiedError("conflict", "Run is not pending or running.")
          : new ClassifiedError("not_found", "Run not found.");
      }
      await writeAudit(tx, {
        userId: user.id,
        action: "run.cancel",
        entity: "run",
        entityId: runId,
      });
    });
    return ok({ runId });
  } catch (err) {
    return fail(err);
  }
}
