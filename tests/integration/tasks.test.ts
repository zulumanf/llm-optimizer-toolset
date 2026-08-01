/**
 * Integration tests for roadmap 1.4 — task management fields (owner, due
 * date, client visibility) and append-only task comments.
 */
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { seedTestActors } from "../helpers/actors";

const TEST_URL = process.env.TEST_DATABASE_URL;
const ROOT = join(__dirname, "..", "..");

const user: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000201",
  email: "op@test.local",
  name: "Operator",
  role: "operator",
};

const owner: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000101",
  email: "fixture+00000000-0000-4000-8000-000000000101@avos.local",
  name: "Fixture Actor",
  role: "operator",
};

// assertCanWrite gates on the session role, so a literal is sufficient here;
// the DB-side role machinery has its own tests in auth-and-roles.test.ts.
const client: CurrentUser = {
  id: "00000000-0000-4000-8000-00000000a002",
  email: "client@example.com",
  name: "Client Viewer",
  role: "client_viewer",
};

const INACTIVE_USER_ID = "00000000-0000-4000-8000-00000000dead";

function isoDaysFromNow(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

describe.skipIf(!TEST_URL)("task management (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let projectSvc: typeof import("@/lib/projects/service");
  let tasks: typeof import("@/lib/tasks/service");

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    projectSvc = await import("@/lib/projects/service");
    tasks = await import("@/lib/tasks/service");
    await sql.unsafe("drop schema public cascade; create schema public;");
    execSync(`npx tsx scripts/migrate.ts up --db "${TEST_URL}"`, {
      cwd: ROOT,
      stdio: "pipe",
    });
    await seedTestActors(sql);
    await sql`
      insert into users (id, email, name, role, active)
      values (${INACTIVE_USER_ID}, 'inactive@test.local', 'Inactive', 'operator', false)
      on conflict (id) do nothing
    `;
  });

  beforeEach(async () => {
    await sql.unsafe(
      "truncate audit_log, task_comments, tasks, evidence, projects cascade"
    );
  });

  afterAll(async () => {
    await sql.end();
  });

  async function seedTask(): Promise<{ projectId: string; taskId: string }> {
    const project = await projectSvc.createProject(user, { name: "Task Mgmt" });
    if (!project.ok) throw new Error(project.error.message);
    const suggested = await tasks.suggestTask(user, {
      projectId: project.data.id,
      title: "Ship the comparison page",
      evidence: [{ kind: "score", refId: randomUUID(), note: "Low rec rate" }],
    });
    if (!suggested.ok) throw new Error(suggested.error.message);
    return { projectId: project.data.id, taskId: suggested.data.taskId };
  }

  it("updateTaskDetails round-trips owner, due date, visibility — and clears them", async () => {
    const { projectId, taskId } = await seedTask();
    const due = isoDaysFromNow(7);

    const set = await tasks.updateTaskDetails(user, {
      taskId,
      ownerId: owner.id,
      dueDate: due,
      clientVisible: true,
    });
    expect(set.ok).toBe(true);

    let list = await tasks.listProjectTasks(projectId);
    expect(list).toHaveLength(1);
    expect(list[0]?.ownerId).toBe(owner.id);
    expect(list[0]?.ownerEmail).toBe(owner.email);
    expect(list[0]?.dueDate).toBe(due);
    expect(list[0]?.clientVisible).toBe(true);
    expect(list[0]?.overdue).toBe(false); // future due date

    // Partial update: only visibility, owner and due date untouched.
    const partial = await tasks.updateTaskDetails(user, {
      taskId,
      clientVisible: false,
    });
    expect(partial.ok).toBe(true);
    list = await tasks.listProjectTasks(projectId);
    expect(list[0]?.ownerId).toBe(owner.id);
    expect(list[0]?.dueDate).toBe(due);
    expect(list[0]?.clientVisible).toBe(false);

    // Explicit nulls unassign and clear.
    const cleared = await tasks.updateTaskDetails(user, {
      taskId,
      ownerId: null,
      dueDate: null,
    });
    expect(cleared.ok).toBe(true);
    list = await tasks.listProjectTasks(projectId);
    expect(list[0]?.ownerId).toBeNull();
    expect(list[0]?.ownerEmail).toBeNull();
    expect(list[0]?.dueDate).toBeNull();

    const audits = await sql`
      select detail from audit_log
      where action = 'task.update_details' and entity_id = ${taskId}
      order by at
    `;
    expect(audits).toHaveLength(3);
    expect(audits[0]?.detail).toEqual({
      ownerId: owner.id,
      dueDate: due,
      clientVisible: true,
    });
    expect(audits[1]?.detail).toEqual({ clientVisible: false });
    expect(audits[2]?.detail).toEqual({ ownerId: null, dueDate: null });
  });

  it("rejects owners that are unknown or inactive", async () => {
    const { taskId } = await seedTask();

    const unknown = await tasks.updateTaskDetails(user, {
      taskId,
      ownerId: randomUUID(),
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.kind).toBe("not_found");

    const inactive = await tasks.updateTaskDetails(user, {
      taskId,
      ownerId: INACTIVE_USER_ID,
    });
    expect(inactive.ok).toBe(false);
    if (!inactive.ok) expect(inactive.error.kind).toBe("not_found");

    const empty = await tasks.updateTaskDetails(user, { taskId });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.kind).toBe("validation");
  });

  it("computes overdue only for past due dates on open tasks", async () => {
    const { projectId, taskId } = await seedTask();
    await tasks.updateTaskDetails(user, { taskId, dueDate: isoDaysFromNow(-2) });

    let list = await tasks.listProjectTasks(projectId);
    expect(list[0]?.overdue).toBe(true);

    // A finished task is late for nobody.
    await tasks.approveTask(user, { taskId });
    await tasks.startTask(user, { taskId });
    await tasks.completeTask(user, { taskId });
    list = await tasks.listProjectTasks(projectId);
    expect(list[0]?.overdue).toBe(false);
  });

  it("comments append in order and refuse mutation", async () => {
    const { projectId, taskId } = await seedTask();

    const first = await tasks.addTaskComment(user, {
      taskId,
      body: "Baseline looks weak; re-run before shipping.",
    });
    expect(first.ok).toBe(true);
    const second = await tasks.addTaskComment(owner, { taskId, body: "Agreed." });
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    const listed = await tasks.listTaskComments(taskId);
    expect(listed.map((c) => c.id)).toEqual([
      first.data.commentId,
      second.data.commentId,
    ]);
    expect(listed[0]?.authorEmail).toBe("fixture+00000000-0000-4000-8000-000000000201@avos.local");
    expect(listed[1]?.body).toBe("Agreed.");

    // Kanban read carries the same thread.
    const list = await tasks.listProjectTasks(projectId);
    expect(list[0]?.comments).toHaveLength(2);

    // Append-only: the forbid_mutation trigger raises on update and delete.
    await expect(
      sql`update task_comments set body = 'edited' where id = ${first.data.commentId}`
    ).rejects.toThrow();
    await expect(
      sql`delete from task_comments where id = ${first.data.commentId}`
    ).rejects.toThrow();

    const audits = await sql`
      select detail from audit_log
      where action = 'task.comment' and entity_id = ${taskId} order by at
    `;
    expect(audits).toHaveLength(2);
    expect(audits[0]?.detail).toEqual({ commentId: first.data.commentId });
  });

  it("rejects empty comments", async () => {
    const { taskId } = await seedTask();
    const empty = await tasks.addTaskComment(user, { taskId, body: "" });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.kind).toBe("validation");
  });

  it("denies read-only client accounts on both new writes", async () => {
    const { taskId } = await seedTask();

    // This service gates before parsing (house pattern in this file since
    // Phase 0.2), so denials surface as throws, matching auth-and-roles.
    await expect(
      tasks.updateTaskDetails(client, { taskId, clientVisible: true })
    ).rejects.toThrow(/read-only/i);
    await expect(
      tasks.addTaskComment(client, { taskId, body: "Client attempt." })
    ).rejects.toThrow(/read-only/i);

    // Nothing was written.
    const comments = await sql`select 1 from task_comments`;
    expect(comments).toHaveLength(0);
    const [row] = await sql`select client_visible from tasks where id = ${taskId}`;
    expect(row?.clientVisible).toBe(false);
  });
});
