/**
 * Spec 053: fleet drift detection end-to-end against real Postgres — seeded
 * score movement across projects becomes one deduped signal, shape flags
 * persist and surface, sentinels alarm on any movement, and the operator
 * queue carries the result.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { seedTestActors } from "../helpers/actors";

const TEST_URL = process.env.TEST_DATABASE_URL;
const ROOT = join(__dirname, "..", "..");

const operator: CurrentUser = {
  id: "00000000-0000-4000-8000-0000000000ef",
  email: "op@test.local",
  name: "Op",
  role: "operator",
};

describe.skipIf(!TEST_URL)("fleet drift detection (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let drift: typeof import("@/lib/drift/detect");

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    drift = await import("@/lib/drift/detect");
    await sql.unsafe("drop schema public cascade; create schema public;");
    execSync(`npx tsx scripts/migrate.ts up --db "${TEST_URL}"`, {
      cwd: ROOT,
      stdio: "pipe",
    });
    await seedTestActors(sql);
  });

  beforeEach(async () => {
    await sql.unsafe(
      `truncate audit_log, drift_signals, scores, responses, runs,
       prompt_set_versions, prompt_sets, companies, projects cascade`
    );
  });

  afterAll(async () => {
    await sql.end();
  });

  /** A project with two comparable runs whose subject moved by `delta`. */
  async function seedMovedProject(
    name: string,
    delta: number,
    kind: "client" | "sentinel" = "client"
  ): Promise<string> {
    const [project] = await sql`
      insert into projects (name, kind) values (${name}, ${kind}) returning id
    `;
    const [company] = await sql`
      insert into companies (name, is_self) values (${name + " Co"}, false)
      returning id
    `;
    await sql`
      update projects set subject_company_id = ${company!.id} where id = ${project!.id}
    `;
    const [set] = await sql`
      insert into prompt_sets (project_id, name) values (${project!.id}, 's')
      returning id
    `;
    const [version] = await sql`
      insert into prompt_set_versions (prompt_set_id, version, frozen_prompts)
      values (${set!.id}, 1, '[]') returning id
    `;
    const runIds: string[] = [];
    for (const startedAgo of ["14 days", "1 day"]) {
      const [run] = await sql`
        insert into runs (project_id, prompt_set_version_id, label, providers,
          trigger, budget_usd, started_at)
        values (${project!.id}, ${version!.id}, ${"r-" + startedAgo}, '[]',
          'manual', 1, now() - ${startedAgo}::interval)
        returning id
      `;
      runIds.push(run!.id as string);
    }
    const base = 0.5;
    for (const [i, runId] of runIds.entries()) {
      const value = i === 0 ? base : base + delta;
      await sql`
        insert into scores (run_id, company_id, metric, provider, value,
          sample_size, scoring_version)
        values
          (${runId}, ${company!.id}, 'mention_rate', 'openai', ${value}, 40, 'v1.1'),
          (${runId}, ${company!.id}, 'mention_rate', 'all', ${value}, 40, 'v1.1')
      `;
    }
    return project!.id as string;
  }

  it("three clients moving together become ONE deduped fleet signal", async () => {
    await seedMovedProject("Client A", -0.2);
    await seedMovedProject("Client B", -0.15);
    await seedMovedProject("Client C", -0.18);
    await seedMovedProject("Client D", 0.01); // stable — not affected

    const first = await drift.detectDriftSignals();
    expect(first.measurableProjects).toBe(4);
    expect(first.fleetSignals).toBe(1);

    const signals = await drift.listDriftSignals("open");
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      kind: "fleet_movement",
      provider: "openai",
      metric: "mention_rate",
      direction: "down",
    });
    expect(signals[0]!.affected.map((a) => a.projectName).sort()).toEqual([
      "Client A",
      "Client B",
      "Client C",
    ]);
    expect(signals[0]!.summary).toContain("3 of 4");

    // Re-running amends nothing and duplicates nothing.
    const second = await drift.detectDriftSignals();
    expect(second.fleetSignals).toBe(0);
    expect(await drift.listDriftSignals("open")).toHaveLength(1);
  });

  it("a persisted shape flag becomes a provider_shape signal", async () => {
    const projectId = await seedMovedProject("Client Shape", 0);
    const [run] = await sql`
      select id from runs where project_id = ${projectId} limit 1
    `;
    await sql`
      insert into responses (run_id, prompt_id, prompt_text, provider, model,
        repetition, response_text, shape_recognized)
      values (${run!.id}, gen_random_uuid(), 'p', 'google', 'gemini-x', 1, '',
        false)
    `;
    const result = await drift.detectDriftSignals();
    expect(result.shapeSignals).toBe(1);
    const signals = await drift.listDriftSignals("open");
    const shape = signals.find((s) => s.kind === "provider_shape");
    expect(shape).toMatchObject({ provider: "google" });
    expect(shape!.summary).toContain("unrecognized");
  });

  it("any movement on a sentinel is the anomaly", async () => {
    await seedMovedProject("Sentinel NYC", -0.12, "sentinel");
    const result = await drift.detectDriftSignals();
    expect(result.sentinelSignals).toBe(1);
    // One sentinel is not a client fleet.
    expect(result.fleetSignals).toBe(0);
    const [signal] = await drift.listDriftSignals("open");
    expect(signal).toMatchObject({ kind: "sentinel_deviation", provider: "openai" });
    expect(signal!.summary).toContain("instrument movement");
  });

  it("acknowledge records the actor, audits, and re-arms detection", async () => {
    await seedMovedProject("Client A", -0.2);
    await seedMovedProject("Client B", -0.2);
    await seedMovedProject("Client C", -0.2);
    await drift.detectDriftSignals();
    const [signal] = await drift.listDriftSignals("open");

    const acked = await drift.acknowledgeDriftSignal(operator, {
      signalId: signal!.id,
      note: "Provider model bump confirmed on status page.",
    });
    expect(acked.ok).toBe(true);
    expect(await drift.listDriftSignals("open")).toHaveLength(0);
    const [row] = await sql`
      select acknowledged_by, acknowledged_note from drift_signals
      where id = ${signal!.id}
    `;
    expect(row?.acknowledgedBy).toBe(operator.id);
    const [audit] = await sql`
      select 1 from audit_log where action = 'drift.signal_acknowledged'
    `;
    expect(audit).toBeDefined();

    // Same fingerprint can open again after acknowledgment.
    const rerun = await drift.detectDriftSignals();
    expect(rerun.fleetSignals).toBe(1);

    // Double-acknowledge refuses.
    const again = await drift.acknowledgeDriftSignal(operator, {
      signalId: signal!.id,
    });
    expect(again.ok).toBe(false);
  });

  it("open drift signals ride the control-tower action queue", async () => {
    await seedMovedProject("Client A", -0.2);
    await seedMovedProject("Client B", -0.2);
    await seedMovedProject("Client C", -0.2);
    await drift.detectDriftSignals();

    const { actionRequiredQueue } = await import("@/lib/control-tower/queue");
    const queue = await actionRequiredQueue({ limit: 20 });
    const item = queue.find((q) => q.source === "drift_signal");
    expect(item).toBeDefined();
    expect(item!.projectName).toBe("Fleet");
    expect(item!.summary).toContain("moved down together");
  });
});
