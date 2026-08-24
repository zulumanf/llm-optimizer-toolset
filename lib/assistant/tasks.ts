/**
 * Delegated assistant tasks (spec 115): a goal the operator confirmed
 * once, advanced by the worker's tick through the SAME dispatch the chat
 * loop uses. Autonomy is read/direct only — confirm-tier tools stage
 * task-linked pending actions and park the task until the operator
 * decides; budgets (steps, LLM cost) are hard limits.
 */
import { z } from "zod";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { isStaff, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { log as logLine } from "@/lib/logger";
import { runAgent, type AgentCaller } from "@/lib/ai/agent";
import { modelForTask } from "@/lib/ai/routing";
import { dispatchToolCall, stepSchema } from "@/lib/assistant/service";
import { assistantTaskPrompt, ASSISTANT_TASK_PROMPT_VERSION } from "@/lib/assistant/prompt";
import { compactCatalog } from "@/lib/assistant/tools";
import { getPreferences } from "@/lib/assistant/preferences";

const TASKS_PER_TICK = 3;
const STEPS_PER_TICK = 5;
/** Tools a task may never call — no recursive delegation. */
const TASK_FORBIDDEN = ["create_task", "cancel_task"] as const;

function assertStaff(user: CurrentUser): void {
  if (!isStaff(user)) {
    throw new ClassifiedError("forbidden", "The assistant is staff-only.");
  }
}

export interface TaskRow {
  id: string;
  userId: string;
  conversationId: string;
  goal: string;
  status: string;
  transcript: string[];
  report: string | null;
  stepsTaken: number;
  maxSteps: number;
  costMicroUsd: number;
  maxCostMicroUsd: number;
  lastError: string | null;
}

function toTask(r: Record<string, unknown>): TaskRow {
  return {
    id: r.id as string,
    userId: r.userId as string,
    conversationId: r.conversationId as string,
    goal: r.goal as string,
    status: r.status as string,
    transcript: (r.transcript as string[]) ?? [],
    report: (r.report as string | null) ?? null,
    stepsTaken: Number(r.stepsTaken ?? 0),
    maxSteps: Number(r.maxSteps),
    costMicroUsd: Number(r.costMicroUsd ?? 0),
    maxCostMicroUsd: Number(r.maxCostMicroUsd),
    lastError: (r.lastError as string | null) ?? null,
  };
}

async function postToConversation(conversationId: string, content: string): Promise<void> {
  await sql`
    insert into assistant_messages (conversation_id, role, content)
    values (${conversationId}, 'assistant', ${content})
  `;
  await sql`
    update assistant_conversations set last_message_at = now() where id = ${conversationId}
  `;
}

const createSchema = z.object({
  goal: z.string().trim().min(10).max(2000),
  maxSteps: z.number().int().min(5).max(50).default(25),
  maxCostUsd: z.number().min(0.1).max(10).default(2),
});

/** Start a delegated task. Called ONLY through the assistant's confirm
 * gate — the confirmation authorizes read/direct autonomy within the
 * stated budgets. */
export async function createTask(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ taskId: string; conversationId: string }>> {
  const parsed = createSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "A goal (10–2000 chars) is required."));
  }
  const input = parsed.data;
  try {
    assertStaff(user);
    const [conversation] = await sql`
      insert into assistant_conversations (user_id, title)
      values (${user.id}, ${"Task: " + input.goal.slice(0, 72)})
      returning id
    `;
    const conversationId = conversation!.id as string;
    const [row] = await sql`
      insert into assistant_tasks
        (user_id, conversation_id, goal, max_steps, max_cost_micro_usd)
      values (${user.id}, ${conversationId}, ${input.goal}, ${input.maxSteps},
        ${Math.round(input.maxCostUsd * 1_000_000)})
      returning id
    `;
    const taskId = row!.id as string;
    await sql.begin((tx) =>
      writeAudit(tx, {
        userId: user.id,
        action: "assistant.task_created",
        entity: "assistant_task",
        entityId: taskId,
        detail: { goal: input.goal, maxSteps: input.maxSteps, maxCostUsd: input.maxCostUsd },
      })
    );
    await postToConversation(
      conversationId,
      `Task started: ${input.goal} (budgets: ${input.maxSteps} steps, $${input.maxCostUsd.toFixed(2)}). The worker advances it; progress and the report land here.`
    );
    return ok({ taskId, conversationId });
  } catch (err) {
    return fail(err);
  }
}

export type TaskListFilter = "active" | "completed" | "failed" | "cancelled" | "all";

export async function listTasks(
  user: CurrentUser,
  filter: TaskListFilter = "active"
): Promise<Array<Omit<TaskRow, "transcript"> & { undecided: number }>> {
  assertStaff(user);
  const where =
    filter === "all"
      ? sql`true`
      : filter === "active"
        ? sql`status in ('running','awaiting_confirmation')`
        : sql`status = ${filter}`;
  const rows = await sql`
    select t.*,
      (select count(*)::int from assistant_pending_actions a
        where a.task_id = t.id and a.status = 'pending') as undecided
    from assistant_tasks t
    where t.user_id = ${user.id} and ${where}
    order by t.updated_at desc
    limit 20
  `;
  return rows.map((r) => {
    const task = toTask(r);
    return {
      id: task.id,
      userId: task.userId,
      conversationId: task.conversationId,
      goal: task.goal,
      status: task.status,
      report: task.report,
      stepsTaken: task.stepsTaken,
      maxSteps: task.maxSteps,
      costMicroUsd: task.costMicroUsd,
      maxCostMicroUsd: task.maxCostMicroUsd,
      lastError: task.lastError,
      undecided: Number(r.undecided ?? 0),
    };
  });
}

export async function getTask(
  user: CurrentUser,
  taskId: string
): Promise<(TaskRow & { transcriptTail: string[] }) | null> {
  assertStaff(user);
  const [row] = await sql`
    select * from assistant_tasks where id = ${taskId} and user_id = ${user.id}
  `;
  if (!row) return null;
  const task = toTask(row);
  return { ...task, transcriptTail: task.transcript.slice(-10) };
}

const cancelSchema = z.object({
  taskId: z.string().uuid(),
  reason: z.string().trim().min(5).max(500),
});

export async function cancelTask(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ taskId: string }>> {
  const parsed = cancelSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "A task id and a reason (5–500 chars) are required."));
  }
  const { taskId, reason } = parsed.data;
  try {
    assertStaff(user);
    let conversationId = "";
    await sql.begin(async (tx) => {
      const [row] = await tx`
        select id, user_id, conversation_id, status from assistant_tasks
        where id = ${taskId} for update
      `;
      if (!row || row.userId !== user.id) {
        throw new ClassifiedError("not_found", "Task not found.");
      }
      if (!["running", "awaiting_confirmation"].includes(row.status as string)) {
        throw new ClassifiedError("conflict", `Task is already ${String(row.status)}.`);
      }
      conversationId = row.conversationId as string;
      await tx`
        update assistant_tasks
        set status = 'cancelled', last_error = ${reason}, updated_at = now()
        where id = ${taskId}
      `;
      // Undecided stagings die with the task — nothing confirmable remains.
      await tx`
        update assistant_pending_actions set status = 'cancelled'
        where task_id = ${taskId} and status = 'pending'
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "assistant.task_cancelled",
        entity: "assistant_task",
        entityId: taskId,
        detail: { reason },
      });
    });
    await postToConversation(conversationId, `Task cancelled by ${user.name}: ${reason}.`);
    return ok({ taskId });
  } catch (err) {
    return fail(err);
  }
}

async function taskUser(task: TaskRow): Promise<CurrentUser> {
  const [u] = await sql`
    select id, email, name, role from users where id = ${task.userId} and active
  `;
  if (!u) throw new ClassifiedError("validation", "The requesting user is no longer active.");
  return {
    id: u.id as string,
    email: u.email as string,
    name: u.name as string,
    role: u.role as CurrentUser["role"],
  };
}

async function persistProgress(task: TaskRow): Promise<void> {
  await sql`
    update assistant_tasks set
      transcript = ${sql.json(task.transcript as never)},
      steps_taken = ${task.stepsTaken},
      cost_micro_usd = ${task.costMicroUsd},
      updated_at = now()
    where id = ${task.id}
  `;
}

async function setTerminal(
  task: TaskRow,
  status: "completed" | "failed" | "awaiting_confirmation",
  message: string,
  extra: { report?: string; lastError?: string } = {}
): Promise<void> {
  await sql`
    update assistant_tasks set
      status = ${status},
      report = coalesce(${extra.report ?? null}, report),
      last_error = ${extra.lastError ?? null},
      transcript = ${sql.json(task.transcript as never)},
      steps_taken = ${task.stepsTaken},
      cost_micro_usd = ${task.costMicroUsd},
      updated_at = now()
    where id = ${task.id}
  `;
  await postToConversation(task.conversationId, message);
  logLine("info", "assistant.task_" + status, { taskId: task.id, steps: task.stepsTaken });
}

async function undecidedCount(taskId: string): Promise<number> {
  const [row] = await sql`
    select count(*)::int as n from assistant_pending_actions
    where task_id = ${taskId} and status = 'pending'
  `;
  return Number(row?.n ?? 0);
}

export interface TaskTickReport {
  advanced: number;
  parked: number;
  resumed: number;
  completed: number;
  failed: number;
}

/** The tick lane: resume decided tasks, then advance running ones.
 * Isolated per task — one failure never blocks another. */
export async function advanceAssistantTasks(caller?: AgentCaller): Promise<TaskTickReport> {
  const report: TaskTickReport = { advanced: 0, parked: 0, resumed: 0, completed: 0, failed: 0 };

  // Resume: every staging decided → outcomes into the transcript, run again.
  const parked = await sql`
    select * from assistant_tasks where status = 'awaiting_confirmation'
    order by updated_at asc limit ${TASKS_PER_TICK}
  `;
  for (const raw of parked) {
    const task = toTask(raw);
    if ((await undecidedCount(task.id)) > 0) continue;
    const decided = await sql`
      select summary, status, result from assistant_pending_actions
      where task_id = ${task.id} order by created_at asc
    `;
    for (const d of decided) {
      const line =
        d.status === "confirmed"
          ? `CONFIRMED: ${d.summary} → ${JSON.stringify(d.result ?? {}).slice(0, 300)}`
          : `DISMISSED (${d.status}): ${d.summary}`;
      task.transcript.push(line);
    }
    await sql`
      update assistant_tasks set status = 'running',
        transcript = ${sql.json(task.transcript as never)}, updated_at = now()
      where id = ${task.id}
    `;
    report.resumed += 1;
  }

  const rows = await sql`
    select * from assistant_tasks where status = 'running'
    order by updated_at asc limit ${TASKS_PER_TICK}
  `;
  for (const raw of rows) {
    const task = toTask(raw);
    try {
      const user = await taskUser(task);
      const system = assistantTaskPrompt({
        userName: user.name,
        today: new Date().toISOString().slice(0, 10),
        goal: task.goal,
        toolCatalog: compactCatalog(),
        preferences: await getPreferences(user),
      });
      let done = false;
      for (let i = 0; i < STEPS_PER_TICK && !done; i += 1) {
        if (task.stepsTaken >= task.maxSteps || task.costMicroUsd >= task.maxCostMicroUsd) {
          const which = task.stepsTaken >= task.maxSteps ? "step" : "cost";
          await setTerminal(
            task,
            "failed",
            `Task stopped: the ${which} budget is exhausted (${task.stepsTaken}/${task.maxSteps} steps, $${(task.costMicroUsd / 1_000_000).toFixed(2)} of $${(task.maxCostMicroUsd / 1_000_000).toFixed(2)}). Partial transcript is preserved — restate a narrower goal to continue.`,
            { lastError: `${which} budget exhausted` }
          );
          report.failed += 1;
          done = true;
          break;
        }
        const run = await runAgent({
          agentVersion: ASSISTANT_TASK_PROMPT_VERSION,
          model: modelForTask("assistant_task"),
          system,
          user: task.transcript.length > 0 ? task.transcript.join("\n\n") : "BEGIN.",
          schema: stepSchema,
          purpose: "assistant_task",
          caller,
        });
        task.costMicroUsd += run.costMicroUsd;
        task.stepsTaken += 1;
        const output = run.output;
        if (output.action === "answer") {
          const undecided = await undecidedCount(task.id);
          if (undecided > 0) {
            await setTerminal(
              task,
              "awaiting_confirmation",
              `Task needs you — ${undecided} staged action${undecided === 1 ? "" : "s"} await confirmation. Interim report: ${output.answer}`
            );
            report.parked += 1;
          } else {
            await setTerminal(task, "completed", `Task complete. ${output.answer}`, {
              report: output.answer,
            });
            report.completed += 1;
          }
          done = true;
          break;
        }
        const outcome = await dispatchToolCall(
          user,
          task.conversationId,
          output.tool,
          output.input,
          { caller, taskId: task.id, forbidden: TASK_FORBIDDEN }
        );
        task.transcript.push(
          `TOOL ${output.tool}(${JSON.stringify(output.input)}) → ${outcome.summary}`
        );
        if (outcome.pendingAction) {
          task.transcript.push(`STAGED: ${outcome.pendingAction.summary}`);
        }
        await persistProgress(task);
        report.advanced += 1;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown";
      await setTerminal(task, "failed", `Task failed: ${message}`, {
        lastError: message.slice(0, 500),
      });
      logLine("warn", "assistant.task_failed", { taskId: task.id, message });
      report.failed += 1;
    }
  }
  return report;
}
