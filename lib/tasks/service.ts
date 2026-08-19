/**
 * Tasks (spec 007, PRINCIPLES.md #8): software suggests with evidence
 * attached; humans approve; completing a task can spawn its intervention so
 * the loop closes with re-measurement.
 */
import { z } from "zod";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { assertCanWrite, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { firstZodMessage } from "@/lib/service-helpers";
import {
  createIntervention,
  interventionView,
  POST_OFFSETS,
} from "@/lib/attribution/service";

const evidenceSchema = z.object({
  // Mirrors the evidence_kind_check constraint (007, widened by 083 with the
  // technical-scan objects).
  kind: z.enum([
    "response", "mention", "score", "source", "report",
    "site_page", "site_scan",
  ]),
  refId: z.string().uuid(),
  note: z.string().min(1).max(500),
});

const suggestSchema = z
  .object({
    projectId: z.string().uuid(),
    title: z
      .string()
      .transform((s) => s.trim())
      .pipe(z.string().min(1, "Title is required.").max(120)),
    description: z.string().max(2000).optional(),
    priority: z.enum(["p1", "p2", "p3"]).default("p2"),
    evidence: z.array(evidenceSchema).default([]),
    /** Existing evidence registry rows to attach as-is (spec 064) — the gap
     * promotion path reuses the finding's rows instead of minting copies. */
    evidenceIds: z.array(z.string().uuid()).default([]),
  })
  .refine((v) => v.evidence.length + v.evidenceIds.length > 0, {
    message: "A suggested task needs evidence.",
  });

export async function suggestTask(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ taskId: string }>> {
  assertCanWrite(user);
  const parsed = suggestSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const input = parsed.data;
  try {
    const taskId = await sql.begin(async (tx) => {
      // Attached existing rows must actually exist in this project — a task
      // whose evidence ids point nowhere would satisfy the CHECK constraint
      // while evidencing nothing.
      if (input.evidenceIds.length > 0) {
        const found = await tx`
          select id from evidence
          where id = any(${input.evidenceIds}::uuid[])
            and project_id = ${input.projectId}
        `;
        if (found.length !== new Set(input.evidenceIds).size) {
          throw new ClassifiedError(
            "validation",
            "One or more attached evidence rows do not exist in this project."
          );
        }
      }
      const evidenceIds: string[] = [...new Set(input.evidenceIds)];
      for (const item of input.evidence) {
        const [row] = await tx`
          insert into evidence (project_id, kind, ref_id, note, created_by)
          values (${input.projectId}, ${item.kind}, ${item.refId}, ${item.note}, ${user.id})
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
  assertCanWrite(user);
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
      // The 90-day plan tracks itself (plan 5.4): a linked plan item follows
      // its task into done — the columns migration 026 shipped finally get
      // a writer.
      if (action === "complete") {
        await tx`
          update plan_items set status = 'done'
          where task_id = ${taskId} and status in ('planned', 'in_progress')
        `;
      }
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

const updateDetailsSchema = z
  .object({
    taskId: z.string().uuid(),
    // null unassigns/clears; absent leaves the field untouched.
    ownerId: z.string().uuid().nullable().optional(),
    dueDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Due date must be YYYY-MM-DD.")
      .nullable()
      .optional(),
    clientVisible: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.ownerId !== undefined ||
      v.dueDate !== undefined ||
      v.clientVisible !== undefined,
    { message: "Nothing to update." }
  );

/** Management fields (roadmap 1.4): owner, due date, client visibility. */
export async function updateTaskDetails(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ taskId: string }>> {
  assertCanWrite(user);
  const parsed = updateDetailsSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const input = parsed.data;
  try {
    await sql.begin(async (tx) => {
      const [task] = await tx`
        select owner_id, due_date::text as due_date, client_visible from tasks
        where id = ${input.taskId} for update
      `;
      if (!task) throw new ClassifiedError("not_found", "Task not found.");

      if (input.ownerId !== undefined && input.ownerId !== null) {
        const [owner] = await tx`
          select 1 from users where id = ${input.ownerId} and active
        `;
        if (!owner) {
          throw new ClassifiedError("not_found", "Owner is not an active user.");
        }
      }

      const changed: Record<string, string | boolean | null> = {};
      if (input.ownerId !== undefined) changed.ownerId = input.ownerId;
      if (input.dueDate !== undefined) changed.dueDate = input.dueDate;
      if (input.clientVisible !== undefined) changed.clientVisible = input.clientVisible;

      await tx`
        update tasks set
          owner_id = ${input.ownerId !== undefined ? input.ownerId : (task.ownerId as string | null)},
          -- due_date round-trips as text: the driver converts date columns
          -- to JS Dates at UTC midnight, and writing one back shifts a day
          -- in negative-offset timezones.
          due_date = ${input.dueDate !== undefined ? input.dueDate : (task.dueDate as string | null)},
          client_visible = ${input.clientVisible !== undefined ? input.clientVisible : (task.clientVisible as boolean)},
          updated_at = now()
        where id = ${input.taskId}
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "task.update_details",
        entity: "task",
        entityId: input.taskId,
        detail: changed,
      });
    });
    return ok({ taskId: input.taskId });
  } catch (err) {
    return fail(err);
  }
}

const commentSchema = z.object({
  taskId: z.string().uuid(),
  body: z.string().min(1, "Comment cannot be empty.").max(4000),
});

/** Append-only discussion — task_comments carries the immutability trigger. */
export async function addTaskComment(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ commentId: string }>> {
  assertCanWrite(user);
  const parsed = commentSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const input = parsed.data;
  try {
    const commentId = await sql.begin(async (tx) => {
      const [task] = await tx`select 1 from tasks where id = ${input.taskId}`;
      if (!task) throw new ClassifiedError("not_found", "Task not found.");
      const [row] = await tx`
        insert into task_comments (task_id, author_id, body)
        values (${input.taskId}, ${user.id}, ${input.body})
        returning id
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "task.comment",
        entity: "task",
        entityId: input.taskId,
        detail: { commentId: row?.id as string },
      });
      return row?.id as string;
    });
    return ok({ commentId });
  } catch (err) {
    return fail(err);
  }
}

export interface TaskComment {
  id: string;
  body: string;
  createdAt: Date;
  authorName: string;
  authorEmail: string;
}

export async function listTaskComments(taskId: string): Promise<TaskComment[]> {
  const rows = await sql`
    select c.id, c.body, c.created_at, u.name as author_name, u.email as author_email
    from task_comments c
    join users u on u.id = c.author_id
    where c.task_id = ${taskId}
    order by c.created_at asc
  `;
  return rows.map((row) => ({
    id: row.id as string,
    body: row.body as string,
    createdAt: row.createdAt as Date,
    authorName: row.authorName as string,
    authorEmail: row.authorEmail as string,
  }));
}

export interface TaskListItem {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  ownerId: string | null;
  ownerName: string | null;
  ownerEmail: string | null;
  dueDate: string | null;
  clientVisible: boolean;
  overdue: boolean;
  evidence: { id: string; kind: string; refId: string; note: string }[];
  comments: { id: string; body: string; createdAt: string; author: string }[];
}

/** The kanban's read: tasks with owner, due date, overdue flag, and comments. */
export async function listProjectTasks(projectId: string): Promise<TaskListItem[]> {
  const rows = await sql`
    select t.id, t.title, t.description, t.status, t.priority,
      t.owner_id, u.name as owner_name, u.email as owner_email,
      to_char(t.due_date, 'YYYY-MM-DD') as due_date,
      t.client_visible,
      (t.due_date is not null and t.due_date < current_date
        and t.status not in ('done', 'rejected')) as overdue,
      coalesce((
        select json_agg(json_build_object('id', e.id, 'kind', e.kind,
          'refId', e.ref_id, 'note', e.note))
        from evidence e where e.id = any(t.evidence_ids)
      ), '[]') as evidence,
      coalesce((
        select json_agg(json_build_object('id', c.id, 'body', c.body,
          'createdAt', to_char(c.created_at, 'YYYY-MM-DD HH24:MI'),
          'author', coalesce(nullif(cu.name, ''), cu.email))
          order by c.created_at asc)
        from task_comments c join users cu on cu.id = c.author_id
        where c.task_id = t.id
      ), '[]') as comments
    from tasks t
    left join users u on u.id = t.owner_id
    where t.project_id = ${projectId}
    order by t.priority asc, t.created_at desc
  `;
  return rows.map((row) => ({
    id: row.id as string,
    title: row.title as string,
    description: row.description as string | null,
    status: row.status as string,
    priority: row.priority as string,
    ownerId: row.ownerId as string | null,
    ownerName: row.ownerName as string | null,
    ownerEmail: row.ownerEmail as string | null,
    dueDate: row.dueDate as string | null,
    clientVisible: row.clientVisible as boolean,
    overdue: row.overdue as boolean,
    evidence: row.evidence as TaskListItem["evidence"],
    comments: row.comments as TaskListItem["comments"],
  }));
}

export interface PortfolioTaskRow {
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  status: string;
  priority: string;
  ownerName: string | null;
  dueDate: string | null;
  overdue: boolean;
}

/**
 * The cross-client work board's read (plan 5.1): every open task in the
 * portfolio in one list. Answers "what do we owe which client this week"
 * — previously ten kanban pages and memory. Staff-only surface; the page
 * gate enforces it.
 */
export async function listOpenTasksAcrossProjects(): Promise<PortfolioTaskRow[]> {
  const rows = await sql`
    select t.id, t.project_id, p.name as project_name, t.title, t.status,
      t.priority, u.name as owner_name,
      to_char(t.due_date, 'YYYY-MM-DD') as due_date,
      (t.due_date is not null and t.due_date < current_date) as overdue
    from tasks t
    join projects p on p.id = t.project_id
    left join users u on u.id = t.owner_id
    where t.status in ('suggested', 'approved', 'in_progress')
      and p.status = 'active'
    order by
      (t.due_date is not null and t.due_date < current_date) desc,
      t.priority asc,
      t.due_date asc nulls last,
      p.name asc
  `;
  return rows.map((row) => ({
    id: row.id as string,
    projectId: row.projectId as string,
    projectName: row.projectName as string,
    title: row.title as string,
    status: row.status as string,
    priority: row.priority as string,
    ownerName: row.ownerName as string | null,
    dueDate: row.dueDate as string | null,
    overdue: Boolean(row.overdue),
  }));
}

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
  assertCanWrite(user);
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
  assertCanWrite(user);
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
