/**
 * Tasks (spec 007, PRINCIPLES.md #8): software suggests with evidence
 * attached; humans approve; completing a task can spawn its intervention so
 * the loop closes with re-measurement.
 */
import { z } from "zod";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import type { CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { firstZodMessage } from "@/lib/service-helpers";
import {
  createIntervention,
  interventionView,
  POST_OFFSETS,
} from "@/lib/attribution/service";

const evidenceSchema = z.object({
  kind: z.enum(["response", "mention", "score", "source", "report"]),
  refId: z.string().uuid(),
  note: z.string().min(1).max(500),
});

const suggestSchema = z.object({
  projectId: z.string().uuid(),
  title: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(1, "Title is required.").max(120)),
  description: z.string().max(2000).optional(),
  priority: z.enum(["p1", "p2", "p3"]).default("p2"),
  evidence: z.array(evidenceSchema).min(1, "A suggested task needs evidence."),
});

export async function suggestTask(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ taskId: string }>> {
  const parsed = suggestSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const input = parsed.data;
  try {
    const taskId = await sql.begin(async (tx) => {
      const evidenceIds: string[] = [];
      for (const item of input.evidence) {
        const [row] = await tx`
          insert into evidence (kind, ref_id, note, created_by)
          values (${item.kind}, ${item.refId}, ${item.note}, ${user.id})
          returning id
        `;
        evidenceIds.push(row?.id as string);
      }
      const [task] = await tx`
        insert into tasks (project_id, title, description, priority, evidence_ids)
        values (${input.projectId}, ${input.title}, ${input.description ?? null},
          ${input.priority}, ${evidenceIds})
        returning id
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "task.suggest",
        entity: "task",
        entityId: task?.id as string,
        detail: { title: input.title, evidenceCount: evidenceIds.length },
      });
      return task?.id as string;
    });
    return ok({ taskId });
  } catch (err) {
    return fail(err);
  }
}

const TRANSITIONS: Record<string, { from: string[]; to: string }> = {
  approve: { from: ["suggested"], to: "approved" },
  reject: { from: ["suggested"], to: "rejected" },
  start: { from: ["approved"], to: "in_progress" },
  complete: { from: ["in_progress", "approved"], to: "done" },
};

async function transition(
  user: CurrentUser,
  raw: unknown,
  action: keyof typeof TRANSITIONS
): Promise<ActionResult<{ taskId: string }>> {
  const parsed = z.object({ taskId: z.string().uuid() }).safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "Invalid task id."));
  }
  const { taskId } = parsed.data;
  const rule = TRANSITIONS[action]!;
  try {
    await sql.begin(async (tx) => {
      const [task] = await tx`
        select status, approved_by from tasks where id = ${taskId} for update
      `;
      if (!task) throw new ClassifiedError("not_found", "Task not found.");
      if (!rule.from.includes(task.status as string)) {
        throw new ClassifiedError(
          "conflict",
          `Cannot ${action} a task in status "${task.status}".`
        );
      }
      if ((action === "start" || action === "complete") && !task.approvedBy) {
        throw new ClassifiedError("conflict", "Task was never approved.");
      }
      await tx`
        update tasks set status = ${rule.to},
          approved_by = ${action === "approve" ? user.id : (task.approvedBy as string | null)},
          updated_at = now()
        where id = ${taskId}
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: `task.${action}`,
        entity: "task",
        entityId: taskId,
      });
    });
    return ok({ taskId });
  } catch (err) {
    return fail(err);
  }
}

export const approveTask = (u: CurrentUser, raw: unknown) => transition(u, raw, "approve");
export const rejectTask = (u: CurrentUser, raw: unknown) => transition(u, raw, "reject");
export const startTask = (u: CurrentUser, raw: unknown) => transition(u, raw, "start");
export const completeTask = (u: CurrentUser, raw: unknown) => transition(u, raw, "complete");

const completeAsInterventionSchema = z.object({
  taskId: z.string().uuid(),
  shippedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  urls: z.array(z.string().url()).max(10).default([]),
  promptSetVersionId: z.string().uuid(),
  postOffsets: z.array(z.enum(POST_OFFSETS)).optional(),
});

/** Done + intervention in one flow — the measured loop closure (docs/00). */
export async function completeTaskAsIntervention(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ taskId: string; interventionId: string }>> {
  const parsed = completeAsInterventionSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const input = parsed.data;
  try {
    const [task] = await sql`
      select project_id, title, status from tasks where id = ${input.taskId}
    `;
    if (!task) return fail(new ClassifiedError("not_found", "Task not found."));

    const completed = await completeTask(user, { taskId: input.taskId });
    if (!completed.ok) return completed;

    const intervention = await createIntervention(user, {
      projectId: task.projectId as string,
      title: task.title as string,
      shippedAt: input.shippedAt,
      urls: input.urls,
      promptSetVersionId: input.promptSetVersionId,
      taskId: input.taskId,
      ...(input.postOffsets ? { postOffsets: input.postOffsets } : {}),
    });
    if (!intervention.ok) return intervention;
    return ok({
      taskId: input.taskId,
      interventionId: intervention.data.interventionId,
    });
  } catch (err) {
    return fail(err);
  }
}

/** Suggested tasks from an intervention's notable verdicts, score-evidenced. */
export async function suggestTasksFromIntervention(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ created: number }>> {
  const parsed = z.object({ interventionId: z.string().uuid() }).safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "Invalid intervention id."));
  }
  try {
    const [intervention] = await sql`
      select project_id, title from interventions where id = ${parsed.data.interventionId}
    `;
    if (!intervention) {
      return fail(new ClassifiedError("not_found", "Intervention not found."));
    }
    const view = await interventionView(parsed.data.interventionId);
    let created = 0;
    for (const verdict of view.verdicts.filter((v) => v.verdict === "notable")) {
      const direction = verdict.delta < 0 ? "drop" : "gain";
      const result = await suggestTask(user, {
        projectId: intervention.projectId as string,
        title: `Investigate notable ${direction} in ${verdict.metric.replace(/_/g, " ")} after "${intervention.title}"`,
        description: `Post-run value ${verdict.postValue.toFixed(3)} vs pooled baseline ${verdict.baselineValue.toFixed(3)} (Δ ${verdict.delta.toFixed(3)}).`,
        priority: verdict.delta < 0 ? "p1" : "p2",
        evidence: [
          {
            kind: "score",
            refId: verdict.postScoreId,
            note: `Notable ${direction}: ${verdict.metric} moved ${verdict.delta.toFixed(3)} vs pooled baseline (docs/06 change detection).`,
          },
        ],
      });
      if (result.ok) created += 1;
    }
    return ok({ created });
  } catch (err) {
    return fail(err);
  }
}
