/**
 * Spec 115 — delegated tasks: the confirm click authorizes read/direct
 * autonomy within hard budgets; confirm-tier tools stage task-linked
 * pending actions and park the task; the operator's decisions resume it;
 * budgets fail loudly; recursion is refused.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import type { AgentCaller } from "@/lib/ai/agent";
import { seedTestActors } from "../helpers/actors";
import { unwrap } from "../helpers/result";

const TEST_URL = process.env.TEST_DATABASE_URL;
const ROOT = join(__dirname, "..", "..");

const operator: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000401",
  email: "op@test.local",
  name: "Operator",
  role: "operator",
};

const P1 = "aaaaaaaa-0000-4000-8000-000000000021";

const scripted = (steps: object[]): AgentCaller => {
  let i = 0;
  return async () => ({
    text: JSON.stringify(steps[Math.min(i++, steps.length - 1)]),
    tokensIn: 100,
    tokensOut: 20,
  });
};

describe.skipIf(!TEST_URL)("assistant delegated tasks (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let confirm: typeof import("@/lib/assistant/confirm");
  let tasks: typeof import("@/lib/assistant/tasks");

  async function newConversation(): Promise<string> {
    const [row] = await sql`
      insert into assistant_conversations (user_id, title)
      values (${operator.id}, 't') returning id
    `;
    return row!.id as string;
  }

  async function startTask(goal: string, maxSteps = 25): Promise<{ taskId: string; conversationId: string }> {
    const pending = await confirm.mintPendingAction(operator, await newConversation(), "create_task", {
      goal,
      max_steps: maxSteps,
    });
    const result = unwrap(await confirm.confirmAssistantAction(operator, { token: pending.token }));
    return result.result as { taskId: string; conversationId: string };
  }

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    confirm = await import("@/lib/assistant/confirm");
    tasks = await import("@/lib/assistant/tasks");
    await sql.unsafe("drop schema public cascade; create schema public;");
    execSync(`npx tsx scripts/migrate.ts up --db "${TEST_URL}"`, { cwd: ROOT, stdio: "pipe" });
    await seedTestActors(sql);
    await sql`insert into markets (id, name, kind) values ('bbbbbbbb-0000-4000-8000-000000000021', 'M', 'city')`;
    await sql`insert into market_launches (id, name, market_id, status)
      values ('cccccccc-0000-4000-8000-000000000021', 'L', 'bbbbbbbb-0000-4000-8000-000000000021', 'researching')`;
    await sql`insert into prospects (id, launch_id, business_name, prospect_type, stage)
      values (${P1}, 'cccccccc-0000-4000-8000-000000000021', 'Task Co', 'team', 'identified')`;
  });

  afterAll(async () => {
    await sql.end();
  });

  it("minting create_task starts nothing; the confirm starts the task", async () => {
    const conversationId = await newConversation();
    await confirm.mintPendingAction(operator, conversationId, "create_task", {
      goal: "Look at Task Co and report their stage.",
    });
    const [before] = await sql`select count(*)::int as n from assistant_tasks`;
    expect(before?.n).toBe(0);
    const started = await startTask("Look at Task Co and report their stage.");
    const [row] = await sql`select status from assistant_tasks where id = ${started.taskId}`;
    expect(row?.status).toBe("running");
    // Leave no running task behind — later ticks would feed it their scripts.
    unwrap(await tasks.cancelTask(operator, { taskId: started.taskId, reason: "Test cleanup." }));
  });

  it("a read/direct task runs to completion: report, conversation message, cost recorded", async () => {
    const started = await startTask("Report Task Co's working state.");
    const report = await tasks.advanceAssistantTasks(
      scripted([
        { action: "tool", tool: "get_prospect", input: { prospect_id: P1 } },
        { action: "answer", answer: "Task Co is at stage identified (per get_prospect)." },
      ])
    );
    expect(report.completed).toBeGreaterThanOrEqual(1);
    const task = (await tasks.getTask(operator, started.taskId))!;
    expect(task.status).toBe("completed");
    expect(task.report).toContain("identified");
    expect(task.costMicroUsd).toBeGreaterThan(0);
    expect(task.transcriptTail.join("\n")).toContain("TOOL get_prospect");
    const [message] = await sql`
      select content from assistant_messages
      where conversation_id = ${started.conversationId}
      order by created_at desc limit 1
    `;
    expect(message?.content).toContain("Task complete");
  });

  it("a confirm-tier step stages, parks, resumes on the decision, then completes", async () => {
    const started = await startTask("Advance Task Co to researching.");
    let report = await tasks.advanceAssistantTasks(
      scripted([
        {
          action: "tool",
          tool: "advance_stage",
          input: { prospect_id: P1, stage: "researching" },
        },
        { action: "answer", answer: "Staged the stage change for your confirmation." },
      ])
    );
    expect(report.parked).toBe(1);
    let task = (await tasks.getTask(operator, started.taskId))!;
    expect(task.status).toBe("awaiting_confirmation");
    // Nothing executed while parked.
    let [p] = await sql`select stage from prospects where id = ${P1}`;
    expect(p?.stage).toBe("identified");

    const [staged] = await sql`
      select token from assistant_pending_actions
      where task_id = ${started.taskId} and status = 'pending'
    `;
    unwrap(await confirm.confirmAssistantAction(operator, { token: staged!.token as string }));
    [p] = await sql`select stage from prospects where id = ${P1}`;
    expect(p?.stage).toBe("researching");

    report = await tasks.advanceAssistantTasks(
      scripted([{ action: "answer", answer: "Done — the stage change was confirmed and applied." }])
    );
    expect(report.resumed).toBe(1);
    expect(report.completed).toBe(1);
    task = (await tasks.getTask(operator, started.taskId))!;
    expect(task.status).toBe("completed");
    expect(task.transcriptTail.join("\n")).toContain("CONFIRMED:");
  });

  it("the step budget fails loudly, and recursion is refused", async () => {
    const started = await startTask("Loop forever.", 5);
    const looping = scripted([
      { action: "tool", tool: "create_task", input: { goal: "a recursive task, refused" } },
      { action: "tool", tool: "list_prospects", input: {} },
      { action: "tool", tool: "list_prospects", input: {} },
      { action: "tool", tool: "list_prospects", input: {} },
      { action: "tool", tool: "list_prospects", input: {} },
      { action: "tool", tool: "list_prospects", input: {} },
    ]);
    await tasks.advanceAssistantTasks(looping); // 5 steps this tick
    const report = await tasks.advanceAssistantTasks(looping); // budget check fails it
    expect(report.failed).toBe(1);
    const task = (await tasks.getTask(operator, started.taskId))!;
    expect(task.status).toBe("failed");
    expect(task.lastError).toContain("budget");
    expect(task.transcriptTail.join("\n")).toContain("cannot be used from inside a task");
    // No recursive task row was ever created.
    const [n] = await sql`
      select count(*)::int as n from assistant_tasks where goal like '%recursive%'
    `;
    expect(n?.n).toBe(0);
  });

  it("the cost budget fails loudly with cost wording, distinct from the step wording", async () => {
    const started = await startTask("Spend the whole cost budget.");
    // Exhaust the cost budget directly — the pre-step check must catch it
    // before any further model call.
    await sql`
      update assistant_tasks set cost_micro_usd = max_cost_micro_usd
      where id = ${started.taskId}
    `;
    const report = await tasks.advanceAssistantTasks(
      scripted([{ action: "answer", answer: "never reached" }])
    );
    expect(report.failed).toBe(1);
    const task = (await tasks.getTask(operator, started.taskId))!;
    expect(task.status).toBe("failed");
    expect(task.lastError).toBe("cost budget exhausted");
    const [message] = await sql`
      select content from assistant_messages
      where conversation_id = ${started.conversationId}
      order by created_at desc limit 1
    `;
    expect(message?.content).toContain("the cost budget is exhausted");
    expect(message?.content).not.toContain("step budget");
  });

  it("cancel_task inside a task is refused as an ERROR transcript line, not a throw", async () => {
    const started = await startTask("Try to cancel yourself, then report.");
    const report = await tasks.advanceAssistantTasks(
      scripted([
        {
          action: "tool",
          tool: "cancel_task",
          input: { task_id: started.taskId, reason: "self-cancel attempt" },
        },
        { action: "answer", answer: "The cancel was refused; nothing else to do." },
      ])
    );
    // The refusal surfaced in-transcript and the loop carried on to the answer.
    expect(report.failed).toBe(0);
    expect(report.completed).toBe(1);
    const task = (await tasks.getTask(operator, started.taskId))!;
    expect(task.status).toBe("completed"); // NOT cancelled — the tool never ran
    expect(task.transcriptTail.join("\n")).toContain(
      'ERROR (validation): "cancel_task" cannot be used from inside a task.'
    );
  });

  it("a deactivated creator fails the task instead of running with stale privileges", async () => {
    const started = await startTask("Run as a user who no longer exists.");
    await sql`update users set active = false where id = ${operator.id}`;
    try {
      const report = await tasks.advanceAssistantTasks(
        scripted([{ action: "answer", answer: "never reached" }])
      );
      expect(report.failed).toBe(1);
    } finally {
      await sql`update users set active = true where id = ${operator.id}`;
    }
    const task = (await tasks.getTask(operator, started.taskId))!;
    expect(task.status).toBe("failed");
    expect(task.lastError).toContain("no longer active");
  });

  it("a demoted creator's task fails on the re-hydrated role, not the role at creation", async () => {
    const started = await startTask("Run as a demoted user.");
    await sql`update users set role = 'client_viewer' where id = ${operator.id}`;
    try {
      const report = await tasks.advanceAssistantTasks(
        scripted([{ action: "answer", answer: "never reached" }])
      );
      expect(report.failed).toBe(1);
    } finally {
      await sql`update users set role = 'admin' where id = ${operator.id}`;
    }
    const task = (await tasks.getTask(operator, started.taskId))!;
    expect(task.status).toBe("failed");
    expect(task.lastError).toContain("staff-only");
  });

  it("cancel ends the task and its undecided stagings", async () => {
    const started = await startTask("Stage something then wait.");
    await tasks.advanceAssistantTasks(
      scripted([
        { action: "tool", tool: "advance_stage", input: { prospect_id: P1, stage: "benchmarking" } },
        { action: "answer", answer: "Staged; waiting on you." },
      ])
    );
    const cancelled = unwrap(
      await tasks.cancelTask(operator, { taskId: started.taskId, reason: "Changed my mind." })
    );
    expect(cancelled.taskId).toBe(started.taskId);
    const [action] = await sql`
      select status from assistant_pending_actions where task_id = ${started.taskId}
    `;
    expect(action?.status).toBe("cancelled");
    // The tick ignores it now.
    const report = await tasks.advanceAssistantTasks(scripted([{ action: "answer", answer: "x" }]));
    expect(report.advanced + report.resumed + report.completed).toBe(0);
  });
});
