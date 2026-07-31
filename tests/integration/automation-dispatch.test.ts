/**
 * The cron heartbeat path (`lib/automation/dispatch.ts`).
 *
 * `deliverEvent` itself is well covered in automation-layer.test.ts with an
 * injected starter. What was untested is the *sweep* around it — the code
 * `POST /api/cron/automation` calls every minute: find undelivered events,
 * deliver each, and report what happened.
 *
 * That is exactly the code where a silent failure is most expensive: it runs
 * unattended, on a schedule, with nobody reading the output unless the numbers
 * look wrong.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { seedTestActors } from "../helpers/actors";

const TEST_URL = process.env.TEST_DATABASE_URL;
const ROOT = join(__dirname, "..", "..");

const user: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000801",
  email: "op@test.local",
  name: "Operator",
  role: "operator",
};

describe.skipIf(!TEST_URL)("automation dispatch sweep (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let dispatch: typeof import("@/lib/automation/dispatch");
  let bus: typeof import("@/lib/events/bus");
  let projectSvc: typeof import("@/lib/projects/service");
  let dbEvents: typeof import("@/db/events");

  let projectId = "";

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    dispatch = await import("@/lib/automation/dispatch");
    bus = await import("@/lib/events/bus");
    projectSvc = await import("@/lib/projects/service");
    dbEvents = await import("@/db/events");

    await sql.unsafe("drop schema public cascade; create schema public;");
    execSync(`npx tsx scripts/migrate.ts up --db "${TEST_URL}"`, {
      cwd: ROOT,
      stdio: "pipe",
    });
    await seedTestActors(sql);
  }, 180_000);

  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    await sql.unsafe(`
      truncate event_delivery_attempts, event_subscriptions, domain_events,
        trigger_fires, automation_triggers, jobs, workflow_exceptions,
        node_runs, workflow_runs, audit_log, projects
      restart identity cascade
    `);
    const created = await projectSvc.createProject(user, { name: "Dispatch Client" });
    if (!created.ok) throw new Error(created.error.message);
    projectId = created.data.id;
  });

  it("reports zero work without inventing any", async () => {
    const result = await dispatch.runEventDelivery();
    expect(result).toEqual({ events: 0, delivered: 0, deadLettered: 0 });
  });

  it("records exactly one attempt per (event, subscription), whatever the outcome", async () => {
    await dispatch.ensureAutomationReady();
    await sql`
      insert into event_subscriptions (event_type, workflow_key, project_id, autonomy_note)
      values ('claim.approved', 'client_weekly_operations_v1', ${projectId}, 'test')
    `;
    const published = await bus.publishEventStandalone({
      type: "claim.approved",
      projectId,
      payload: { claimId: "11111111-1111-4111-8111-111111111111", subject: "test" },
    });

    const first = await dispatch.runEventDelivery();
    expect(first.events).toBe(1);

    const attempts = await sql`
      select subscription_id from event_delivery_attempts where event_id = ${published.event.id}
    `;
    expect(attempts).toHaveLength(1);
  });

  it("records a workflow that cannot start as failed, with the reason, and keeps sweeping", async () => {
    await dispatch.ensureAutomationReady();
    // This workflow needs connected providers, and a bare database has none.
    // Refusing to start is correct — what matters is that the sweep records
    // WHY rather than throwing, so the next event still gets processed.
    await sql`
      insert into event_subscriptions (event_type, workflow_key, project_id, autonomy_note)
      values ('claim.approved', 'client_weekly_operations_v1', ${projectId}, 'test')
    `;
    const published = await bus.publishEventStandalone({
      type: "claim.approved",
      projectId,
      payload: { claimId: "66666666-6666-4666-8666-666666666666", subject: "no-connector" },
    });

    const result = await dispatch.runEventDelivery();
    expect(result.events).toBe(1);
    expect(result.delivered).toBe(0);

    const [attempt] = await sql`
      select status, last_error from event_delivery_attempts
      where event_id = ${published.event.id}
    `;
    expect(attempt!.status).toBe("failed");
    // A reason an operator can act on, not a stack trace.
    expect(attempt!.lastError).toContain("no connected provider");
    expect(attempt!.lastError).toContain("Connect the provider");
  });

  it("re-sweeps a failed delivery once its backoff has elapsed", async () => {
    await dispatch.ensureAutomationReady();
    await sql`
      insert into event_subscriptions (event_type, workflow_key, project_id, autonomy_note)
      values ('claim.approved', 'client_weekly_operations_v1', ${projectId}, 'test')
    `;
    const published = await bus.publishEventStandalone({
      type: "claim.approved",
      projectId,
      payload: { claimId: "77777777-7777-4777-8777-777777777777", subject: "retry" },
    });

    await dispatch.runEventDelivery();
    // Still backing off: the sweep must not hammer a failing subscription.
    expect((await dispatch.runEventDelivery()).events).toBe(0);

    await sql`
      update event_delivery_attempts set next_attempt_at = now() - interval '1 minute'
      where event_id = ${published.event.id}
    `;
    expect((await dispatch.runEventDelivery()).events).toBe(1);
  });

  it("respects its batch limit rather than draining the backlog in one pass", async () => {
    await dispatch.ensureAutomationReady();
    await sql`
      insert into event_subscriptions (event_type, workflow_key, project_id, autonomy_note)
      values ('claim.approved', 'client_weekly_operations_v1', ${projectId}, 'test')
    `;
    for (let i = 0; i < 5; i += 1) {
      await bus.publishEventStandalone({
        type: "claim.approved",
        projectId,
        payload: { claimId: `1111111${i}-1111-4111-8111-111111111111`, subject: `c${i}` },
        dedupeKey: `sweep-${i}`,
      });
    }

    const limited = await dispatch.runEventDelivery(2);
    expect(limited.events).toBe(2);

    const remaining = await dispatch.runEventDelivery(50);
    expect(remaining.events).toBe(3);
  });

  it("ignores an event nothing subscribed to, rather than treating it as work", async () => {
    await bus.publishEventStandalone({
      type: "claim.approved",
      projectId,
      payload: { claimId: "22222222-2222-4222-8222-222222222222", subject: "orphan" },
    });

    const result = await dispatch.runEventDelivery();
    // The sweep joins events to subscriptions, so an event with no subscriber
    // is not pending work — it is nothing to do. Counting it as a swept event
    // would make the heartbeat look busy while achieving nothing.
    expect(result).toEqual({ events: 0, delivered: 0, deadLettered: 0 });
    expect(await sql`select id from event_delivery_attempts`).toHaveLength(0);
  });

  it("does not deliver one client's event to another client's subscription", async () => {
    await dispatch.ensureAutomationReady();
    const other = await projectSvc.createProject(user, { name: "Other Client" });
    if (!other.ok) throw new Error(other.error.message);

    await sql`
      insert into event_subscriptions (event_type, workflow_key, project_id, autonomy_note)
      values ('claim.approved', 'client_weekly_operations_v1', ${other.data.id}, 'test')
    `;
    await bus.publishEventStandalone({
      type: "claim.approved",
      projectId,
      payload: { claimId: "33333333-3333-4333-8333-333333333333", subject: "scoped" },
    });

    const result = await dispatch.runEventDelivery();
    expect(result.delivered).toBe(0);

    const runs = await sql`select project_id from workflow_runs`;
    expect(runs).toHaveLength(0);
  });

  it("delivers one specific event through the job handler path", async () => {
    await dispatch.ensureAutomationReady();
    await sql`
      insert into event_subscriptions (event_type, workflow_key, project_id, autonomy_note)
      values ('claim.approved', 'client_weekly_operations_v1', ${projectId}, 'test')
    `;
    const published = await bus.publishEventStandalone({
      type: "claim.approved",
      projectId,
      payload: { claimId: "44444444-4444-4444-8444-444444444444", subject: "direct" },
    });

    await dispatch.deliverOneEvent(published.event.id);

    const attempts = await sql`
      select status from event_delivery_attempts where event_id = ${published.event.id}
    `;
    expect(attempts).toHaveLength(1);

    // Re-running the same job must not create a second attempt row — the
    // unique (event, subscription) index is the exactly-once guarantee, and
    // the job handler is re-driven by the queue on every retry.
    await dispatch.deliverOneEvent(published.event.id);
    expect(
      await sql`select id from event_delivery_attempts where event_id = ${published.event.id}`
    ).toHaveLength(1);
  });

  it("is idempotent when bootstrapped repeatedly", async () => {
    await dispatch.ensureAutomationReady();
    await dispatch.ensureAutomationReady();
    const definitions = await sql`select key from workflow_definitions`;
    const keys = definitions.map((row) => row.key as string);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("fires no triggers when none are due, and says so", async () => {
    const result = await dispatch.runTriggerDispatch(new Date("2026-01-01T00:00:00Z"));
    expect(result.fired).toBe(0);
    expect(result.failed).toBe(0);
  });

  it("only sweeps events that have no delivery attempt yet", async () => {
    await dispatch.ensureAutomationReady();
    await sql`
      insert into event_subscriptions (event_type, workflow_key, project_id, autonomy_note)
      values ('claim.approved', 'client_weekly_operations_v1', ${projectId}, 'test')
    `;
    const published = await bus.publishEventStandalone({
      type: "claim.approved",
      projectId,
      payload: { claimId: "55555555-5555-4555-8555-555555555555", subject: "once" },
    });

    const before = await dbEvents.undeliveredEventIds(50);
    expect(before).toContain(published.event.id);

    await dispatch.runEventDelivery();

    const after = await dbEvents.undeliveredEventIds(50);
    expect(after).not.toContain(published.event.id);
  });
});
