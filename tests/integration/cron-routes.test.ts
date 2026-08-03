/**
 * The weekly-cycle cron route — the pilot's heartbeat.
 *
 * startWeeklyCycles is covered through the cycles service, but the route
 * itself (bearer auth → cycles + per-client weekly briefs, C4) had no test.
 * The property that matters most is idempotency per (project, ISO week): a
 * launchd agent that misfires twice on Monday morning must not double-start
 * a client's brief workflow.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { seedTestActors } from "../helpers/actors";

const TEST_URL = process.env.TEST_DATABASE_URL;
const ROOT = join(__dirname, "..", "..");
const SECRET = "test-cron-secret";

function post(secret?: string): Request {
  return new Request("http://localhost:3000/api/cron/weekly-cycle", {
    method: "POST",
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  });
}

describe.skipIf(!TEST_URL)("weekly-cycle cron route (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let route: typeof import("@/app/api/cron/weekly-cycle/route");
  let projectSvc: typeof import("@/lib/projects/service");

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    route = await import("@/app/api/cron/weekly-cycle/route");
    projectSvc = await import("@/lib/projects/service");
    const templates = await import("@/lib/workflow/templates");

    await sql.unsafe("drop schema public cascade; create schema public;");
    execSync(`npx tsx scripts/migrate.ts up --db "${TEST_URL}"`, { cwd: ROOT, stdio: "pipe" });
    await seedTestActors(sql);
    // The route starts weekly_brief_v1 per client — the definition must be
    // published exactly as the worker's bootstrap publishes it.
    await templates.bootstrapWorkflows();
  });

  beforeEach(async () => {
    await sql.unsafe(
      `truncate audit_log, jobs, workflow_transitions, workflow_signals,
       workflow_approvals, workflow_exceptions, node_runs, workflow_runs,
       cycle_runs, executive_briefs, client_health_snapshots, projects cascade`
    );
    vi.stubEnv("CRON_SECRET", SECRET);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await sql.end();
  });

  it("fails closed without a configured secret, and rejects a wrong bearer", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await route.POST(post(SECRET))).status).toBe(503);

    vi.stubEnv("CRON_SECRET", SECRET);
    expect((await route.POST(post())).status).toBe(401);
    expect((await route.POST(post("wrong-secret"))).status).toBe(401);
  });

  it("starts one brief workflow per active client, idempotent across repeat fires", async () => {
    const projectA = await projectSvc.createProject(
      { id: "00000000-0000-4000-8000-000000009001", email: "op@test.local", name: "Op", role: "admin" },
      { name: "Client A" }
    );
    const projectB = await projectSvc.createProject(
      { id: "00000000-0000-4000-8000-000000009001", email: "op@test.local", name: "Op", role: "admin" },
      { name: "Client B" }
    );
    if (!projectA.ok || !projectB.ok) throw new Error("project seed failed");

    const first = await route.POST(post(SECRET));
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { briefs: { started: number; skipped: number } };
    expect(firstBody.briefs.started).toBe(2);
    expect(firstBody.briefs.skipped).toBe(0);

    // The misfire: launchd (or a human) hits the route again the same week.
    const second = await route.POST(post(SECRET));
    expect(second.status).toBe(200);

    // Duplicate starts collapse on the idempotency key — one run per
    // (project, week), not one per fire.
    const runs = await sql`
      select r.project_id, r.idempotency_key from workflow_runs r
      join workflow_versions v on v.id = r.version_id
      join workflow_definitions d on d.id = v.definition_id
      where d.key = 'weekly_brief_v1'
    `;
    expect(runs).toHaveLength(2);
    expect(new Set(runs.map((r) => r.projectId))).toEqual(
      new Set([projectA.data.id, projectB.data.id])
    );
    for (const run of runs) {
      expect(String(run.idempotencyKey)).toMatch(/^weekly-brief:.+:\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("an archived client gets no brief workflow", async () => {
    const admin = {
      id: "00000000-0000-4000-8000-000000009001",
      email: "op@test.local",
      name: "Op",
      role: "admin" as const,
    };
    const active = await projectSvc.createProject(admin, { name: "Active Co" });
    const archived = await projectSvc.createProject(admin, { name: "Archived Co" });
    if (!active.ok || !archived.ok) throw new Error("project seed failed");
    await sql`update projects set status = 'archived' where id = ${archived.data.id}`;

    const response = await route.POST(post(SECRET));
    const body = (await response.json()) as { briefs: { started: number } };
    expect(body.briefs.started).toBe(1);

    const runs = await sql`
      select project_id from workflow_runs
    `;
    expect(runs.map((r) => r.projectId)).toEqual([active.data.id]);
  });
});
