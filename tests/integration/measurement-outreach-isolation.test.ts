/**
 * Spec 159 — measurement/outreach isolation. With AUTOMATION_MODE and
 * OUTBOUND_SENDS_ENABLED unset (the production default), the worker runs a
 * measurement end to end and nothing else; nothing consequential leaves the
 * building; a code bootstrap never re-enables what an operator switched off.
 *
 * tests/setup.ts pins both variables to the pre-spec behaviour for the rest
 * of the suite; every test here deletes them to exercise the defaults.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { seedTestActors } from "../helpers/actors";
import { truncateAll } from "../helpers/db";
import { unwrap } from "../helpers/result";

const TEST_URL = process.env.TEST_DATABASE_URL;
const user: CurrentUser = { id: "00000000-0000-4000-8000-000000000401", email: "op@test.local", name: "Operator", role: "operator" };
const admin: CurrentUser = { id: "00000000-0000-4000-8000-000000000001", email: "admin@test.local", name: "Admin", role: "admin" };

const NON_MEASUREMENT = ["advance_workflow", "deliver_events", "start_scheduled_run", "render_video_walkthrough", "advance_cycle", "dispatch_triggers"];

describe.skipIf(!TEST_URL)("spec 159: measurement/outreach isolation (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let jobs: typeof import("@/db/jobs");
  let core: typeof import("@/workers/core");
  let mock: typeof import("@/lib/ai/mock");
  const saved = { mode: process.env.AUTOMATION_MODE, outbound: process.env.OUTBOUND_SENDS_ENABLED };

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    await truncateAll(sql);
    jobs = await import("@/db/jobs");
    core = await import("@/workers/core");
    mock = await import("@/lib/ai/mock");
    await seedTestActors(sql);
  });

  beforeEach(async () => {
    delete process.env.AUTOMATION_MODE;
    delete process.env.OUTBOUND_SENDS_ENABLED;
    await sql.unsafe("truncate audit_log, jobs, scores, response_parses, mentions, responses, runs, companies, prompt_set_versions, prompts, prompt_sets, projects cascade");
    mock.resetMockProvider();
  });

  afterEach(() => {
    process.env.AUTOMATION_MODE = saved.mode;
    process.env.OUTBOUND_SENDS_ENABLED = saved.outbound;
  });

  afterAll(async () => {
    await sql.end();
  });

  async function plantNonMeasurementJobs(): Promise<string[]> {
    const ids: string[] = [];
    for (const type of NON_MEASUREMENT) {
      const [row] = await sql`insert into jobs (type, payload) values (${type}, ${sql.json({ planted: true } as never)}) returning id`;
      ids.push(row!.id as string);
    }
    return ids;
  }

  async function untouched(ids: string[]): Promise<void> {
    const rows = await sql`select status, attempts, locked_by from jobs where id = any(${ids}::uuid[])`;
    expect(rows).toHaveLength(ids.length);
    for (const r of rows) expect(r).toMatchObject({ status: "queued", attempts: 0, lockedBy: null });
  }

  it("D1: with every variable unset a measurement runs end to end; every other job stays queued and untouched", async () => {
    const planted = await plantNonMeasurementJobs();
    const projectSvc = await import("@/lib/projects/service");
    const setSvc = await import("@/lib/prompts/set-service");
    const promptSvc = await import("@/lib/prompts/prompt-service");
    const runSvc = await import("@/lib/runs/service");
    const project = unwrap(await projectSvc.createProject(user, { name: "Isolation measurement" }));
    const companySvc = await import("@/lib/companies/service");
    unwrap(await companySvc.upsertCompany(admin, { name: "Lumina Isolation", aliases: [], domain: "lumina-isolation.example", isSelf: true }));
    const set = unwrap(await setSvc.createPromptSet(user, { projectId: project.id, name: "Set" }));
    for (const text of ["Who is the best agent in Albuquerque?", "Recommend a listing agent in Rio Rancho."]) {
      unwrap(await promptSvc.addPrompt(user, { setId: set.id, text, category: "recommendation" }));
    }
    unwrap(await setSvc.freezePromptSet(user, { id: set.id }));
    const [version] = await sql`select id from prompt_set_versions where prompt_set_id = ${set.id}`;
    const run = unwrap(await runSvc.startRun(user, { projectId: project.id, promptSetVersionId: version!.id as string, providers: [{ provider: "mock", model: "mock-model", repetitions: 1 }], budgetUsd: 5, label: "isolation" }));

    const types: string[] = [];
    for (let i = 0; i < 50; i++) {
      const outcome = await core.dispatchOnce("isolation-worker");
      if (outcome.status === "idle") break;
      types.push(outcome.type);
      expect(outcome.status).toBe("done");
    }
    expect(types).toContain("execute_run");
    expect(types).toContain("parse_response");
    expect(types).toContain("compute_scores");
    expect(types.every((t) => !NON_MEASUREMENT.includes(t))).toBe(true);
    const [r] = await sql`select status from runs where id = ${run.id}`;
    expect(r?.status).toBe("completed");
    await untouched(planted);

    // A reclaimed non-measurement lease goes back to queued and stays there (G9).
    await sql`update jobs set status = 'running', locked_by = 'dead', locked_at = now() - interval '1 hour', attempts = 1 where id = ${planted[0]!}`;
    await jobs.reclaimStaleJobs(15);
    expect((await core.dispatchOnce("isolation-worker")).status).toBe("idle");
    const [reclaimed] = await sql`select status from jobs where id = ${planted[0]!}`;
    expect(reclaimed?.status).toBe("queued");
  });

  it("D1: AUTOMATION_MODE=full claims every job type again; a typo never means full", async () => {
    const mode = await import("@/lib/ops/mode");
    for (const v of [undefined, "", "Full", "ful", "true", "measurement_only"]) {
      expect(mode.automationMode({ AUTOMATION_MODE: v })).toBe("measurement_only");
    }
    expect(mode.automationMode({ AUTOMATION_MODE: "full" })).toBe("full");
    const [planted] = await plantNonMeasurementJobs();
    expect(await jobs.claimNextJob("w", mode.claimableJobTypes())).toBeNull();
    process.env.AUTOMATION_MODE = "full";
    expect(mode.claimableJobTypes()).toBeNull();
    const claimed = await jobs.claimNextJob("w", mode.claimableJobTypes());
    expect(claimed?.id).toBe(planted);
  });

  it("D1: every measurement job type has a worker handler", async () => {
    const { MEASUREMENT_JOB_TYPES } = await import("@/lib/ops/mode");
    for (const t of MEASUREMENT_JOB_TYPES) expect(Object.keys(core.handlers), t).toContain(t);
  });

  it("D2: a live consequential capability is refused before any lookup while sends are off; the gate is the only thing in the way", async () => {
    const execute = await import("@/lib/connectors/execute");
    const { CONSEQUENTIAL_CAPABILITIES } = await import("@/lib/connectors/types");
    const fetchImpl = vi.fn();
    const [project] = await sql`insert into projects (name) values ('Isolation connector') returning id`;
    for (const capability of CONSEQUENTIAL_CAPABILITIES) {
      const off = await execute.executeCapability({ capability, projectId: project!.id as string, input: { to: "agent@example.com" }, mode: "live", fetchImpl });
      expect(off, capability).toMatchObject({ ok: false, errorCode: "outbound_disabled", retryable: false, connectionId: null });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    // Sends on: the same call proceeds to connection lookup (and stops there, unconnected).
    process.env.OUTBOUND_SENDS_ENABLED = "true";
    const on = await execute.executeCapability({ capability: "email.send_approved_message", projectId: project!.id as string, input: { to: "agent@example.com" }, mode: "live", fetchImpl });
    expect(on.errorCode).toBe("no_connection");
    // Only the exact string "true" enables.
    const mode = await import("@/lib/ops/mode");
    for (const v of [undefined, "", "TRUE", "1", "yes"]) expect(mode.outboundSendsEnabled({ OUTBOUND_SENDS_ENABLED: v })).toBe(false);
  });

  it("D2: non-consequential capabilities are unaffected by the switch", async () => {
    const execute = await import("@/lib/connectors/execute");
    const [project] = await sql`insert into projects (name) values ('Isolation read') returning id`;
    const read = await execute.executeCapability({ capability: "email.create_draft", projectId: project!.id as string, input: {}, mode: "live" });
    expect(read.errorCode).toBe("no_connection");
  });

  it("D4: bootstrap never re-enables an operator-disabled trigger or subscription, still forces templates off, and seeds new rows with their default", async () => {
    const { bootstrapAutomation } = await import("@/lib/automation/workflows");
    await sql.unsafe("truncate automation_triggers, event_subscriptions cascade");
    await bootstrapAutomation();
    const CONTROL = "daily_control_tower_v1:control_tower_daily";
    const [fresh] = await sql`select enabled from automation_triggers where key = ${CONTROL}`;
    expect(fresh?.enabled).toBe(true);
    const [sub] = await sql`select id, enabled from event_subscriptions where project_id is null order by id limit 1`;
    expect(sub?.enabled).toBe(true);
    const [template] = await sql`select key, enabled from automation_triggers where kind = 'schedule' and key <> ${CONTROL} and project_id is null limit 1`;
    expect(template?.enabled).toBe(false);

    // The operator switches the control tower and one subscription off, and
    // (wrongly) enables a client-scoped template trigger.
    await sql`update automation_triggers set enabled = false where key = ${CONTROL}`;
    await sql`update event_subscriptions set enabled = false where id = ${sub!.id}`;
    await sql`update automation_triggers set enabled = true where key = ${template!.key}`;
    await bootstrapAutomation();

    expect((await sql`select enabled from automation_triggers where key = ${CONTROL}`)[0]?.enabled).toBe(false);
    expect((await sql`select enabled from event_subscriptions where id = ${sub!.id}`)[0]?.enabled).toBe(false);
    expect((await sql`select enabled from automation_triggers where key = ${template!.key}`)[0]?.enabled).toBe(false);
    // Nothing else flipped on.
    const [{ n }] = (await sql`select count(*)::int as n from event_subscriptions where project_id is null and enabled = false`) as unknown as [{ n: number }];
    expect(n).toBe(1);
  });

  it("D1: the tick, weekly kick and weekly baselines skip in measurement_only — no trigger, event, send or run", async () => {
    const tick = await import("@/lib/ops/tick");
    await plantNonMeasurementJobs();
    const before = await sql`select (select count(*) from runs)::int as runs, (select count(*) from jobs)::int as jobs, (select count(*) from audit_log)::int as audit`;
    expect(await tick.runAutomationTick({ includeHealth: true })).toEqual({ skipped: "measurement_only" });
    expect(await tick.runWeeklyKick()).toEqual({ skipped: "measurement_only" });
    expect(await tick.runWeeklyBaselines()).toEqual({ skipped: "measurement_only" });
    const after = await sql`select (select count(*) from runs)::int as runs, (select count(*) from jobs)::int as jobs, (select count(*) from audit_log)::int as audit`;
    expect(after).toEqual(before);
  });

  it("D1: the cron automation route returns skipped in measurement_only", async () => {
    process.env.CRON_SECRET = "spec-159-secret";
    const { POST } = await import("@/app/api/cron/automation/route");
    const res = await POST(new Request("http://local/api/cron/automation", { method: "POST", headers: { authorization: "Bearer spec-159-secret" } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: "measurement_only" });
    delete process.env.CRON_SECRET;
  });
});
