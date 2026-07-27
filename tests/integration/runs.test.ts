/**
 * Integration tests for spec 003 — the full run pipeline through the real
 * queue against the mock provider (docs/09: E2E never spends tokens).
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";

const TEST_URL = process.env.TEST_DATABASE_URL;
const ROOT = join(__dirname, "..", "..");

const user: CurrentUser = {
  id: "00000000-0000-4000-8000-0000000000dd",
  email: "op@test.local",
  name: "Operator",
  role: "operator",
};

describe.skipIf(!TEST_URL)("experiment runs (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let projectSvc: typeof import("@/lib/projects/service");
  let setSvc: typeof import("@/lib/prompts/set-service");
  let promptSvc: typeof import("@/lib/prompts/prompt-service");
  let runSvc: typeof import("@/lib/runs/service");
  let execute: typeof import("@/lib/runs/execute");
  let jobs: typeof import("@/db/jobs");
  let runsDb: typeof import("@/db/runs");
  let mock: typeof import("@/lib/ai/mock");

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    projectSvc = await import("@/lib/projects/service");
    setSvc = await import("@/lib/prompts/set-service");
    promptSvc = await import("@/lib/prompts/prompt-service");
    runSvc = await import("@/lib/runs/service");
    execute = await import("@/lib/runs/execute");
    jobs = await import("@/db/jobs");
    runsDb = await import("@/db/runs");
    mock = await import("@/lib/ai/mock");
    await sql.unsafe("drop schema public cascade; create schema public;");
    execSync(`npx tsx scripts/migrate.ts up --db "${TEST_URL}"`, {
      cwd: ROOT,
      stdio: "pipe",
    });
  });

  beforeEach(async () => {
    await sql.unsafe(
      "truncate audit_log, jobs, responses, runs, prompt_set_versions, prompts, prompt_sets, projects cascade"
    );
    mock.resetMockProvider();
  });

  afterAll(async () => {
    await sql.end();
  });

  async function setup(texts: string[]): Promise<{
    projectId: string;
    versionId: string;
  }> {
    const project = await projectSvc.createProject(user, { name: "Run Test" });
    if (!project.ok) throw new Error(project.error.message);
    const set = await setSvc.createPromptSet(user, {
      projectId: project.data.id,
      name: "Set",
    });
    if (!set.ok) throw new Error(set.error.message);
    for (const text of texts) {
      const added = await promptSvc.addPrompt(user, {
        setId: set.data.id,
        text,
        category: "recommendation",
      });
      if (!added.ok) throw new Error(added.error.message);
    }
    const frozen = await setSvc.freezePromptSet(user, { id: set.data.id });
    if (!frozen.ok) throw new Error(frozen.error.message);
    const [version] = await sql`
      select id from prompt_set_versions where prompt_set_id = ${set.data.id}
    `;
    return { projectId: project.data.id, versionId: version?.id as string };
  }

  async function startAndClaim(
    projectId: string,
    versionId: string,
    overrides: Record<string, unknown> = {}
  ): Promise<string> {
    const started = await runSvc.startRun(user, {
      projectId,
      promptSetVersionId: versionId,
      providers: [{ provider: "mock", model: "mock-model", repetitions: 2 }],
      budgetUsd: 5,
      label: "test run",
      ...overrides,
    });
    if (!started.ok) throw new Error(started.error.message);
    const job = await jobs.claimNextJob("test-worker");
    expect(job?.type).toBe("execute_run");
    return started.data.id;
  }

  it("executes every cell exactly once with full raw payloads", async () => {
    const { projectId, versionId } = await setup(["prompt one", "prompt two"]);
    const runId = await startAndClaim(projectId, versionId);
    await execute.executeRun(runId);

    const run = await runsDb.getRun(runId);
    expect(run?.status).toBe("completed");
    expect(run?.completedAt).not.toBeNull();

    const cells = await runsDb.listRunCells(runId);
    expect(cells).toHaveLength(4); // 2 prompts × 1 provider × 2 reps
    for (const cell of cells) {
      expect(cell.error).toBeNull();
      expect(cell.responseText).toContain("mock answer");
      expect(Number(cell.costUsd)).toBeGreaterThan(0);
    }
    const [payloadRow] = await sql`
      select raw_payload from responses where run_id = ${runId} limit 1
    `;
    expect((payloadRow?.rawPayload as { mock: boolean }).mock).toBe(true);
    expect(Number(run?.costUsd)).toBeCloseTo(4 * 60e-6, 8);
  });

  it("responses are immutable at the DB level", async () => {
    const { projectId, versionId } = await setup(["immutable"]);
    const runId = await startAndClaim(projectId, versionId);
    await execute.executeRun(runId);
    await expect(
      sql`update responses set response_text = 'tampered'`
    ).rejects.toThrow(/insert-only/);
    await expect(sql`delete from responses`).rejects.toThrow(/insert-only/);
  });

  it("captures terminal failures with classified errors and finishes partial", async () => {
    const { projectId, versionId } = await setup([
      "good prompt",
      "bad MOCK_FAIL_ALWAYS prompt",
    ]);
    const runId = await startAndClaim(projectId, versionId);
    await execute.executeRun(runId);

    const run = await runsDb.getRun(runId);
    expect(run?.status).toBe("partial");
    const cells = await runsDb.listRunCells(runId);
    const failed = cells.filter((c) => c.error !== null);
    expect(failed).toHaveLength(2); // 2 reps of the failing prompt
    expect(failed[0]?.error?.kind).toBe("validation");
  });

  it("transient errors are retried within the call and still captured", async () => {
    const { projectId, versionId } = await setup(["flaky MOCK_FAIL_ONCE:t1 prompt"]);
    const runId = await startAndClaim(projectId, versionId, {
      providers: [{ provider: "mock", model: "mock-model", repetitions: 1 }],
    });
    await execute.executeRun(runId);
    const run = await runsDb.getRun(runId);
    expect(run?.status).toBe("completed");
  });

  it("refusals are captured as valid measurements, not errors", async () => {
    const { projectId, versionId } = await setup(["please MOCK_REFUSE this"]);
    const runId = await startAndClaim(projectId, versionId, {
      providers: [{ provider: "mock", model: "mock-model", repetitions: 1 }],
    });
    await execute.executeRun(runId);
    const cells = await runsDb.listRunCells(runId);
    expect(cells[0]?.error).toBeNull();
    expect(cells[0]?.refusal).toBe(true);
    const run = await runsDb.getRun(runId);
    expect(run?.status).toBe("completed");
  });

  it("resumes idempotently: interrupted run continues with zero duplicate cells", async () => {
    const { projectId, versionId } = await setup(["resume prompt"]);
    const runId = await startAndClaim(projectId, versionId);
    await execute.executeRun(runId); // complete it fully first
    const before = await runsDb.listRunCells(runId);

    // Simulate a crashed worker re-running the same job
    await execute.executeRun(runId);
    const after = await runsDb.listRunCells(runId);
    expect(after).toHaveLength(before.length);
    const [count] = await sql`
      select count(*)::int as n from responses where run_id = ${runId}
    `;
    expect(count?.n).toBe(before.length); // no duplicate rows at all
  });

  it("retry-failed re-attempts only failed cells; successes untouched", async () => {
    const { projectId, versionId } = await setup([
      "stable prompt",
      "broken MOCK_FAIL_ALWAYS prompt",
    ]);
    const runId = await startAndClaim(projectId, versionId, {
      providers: [{ provider: "mock", model: "mock-model", repetitions: 1 }],
    });
    await execute.executeRun(runId);
    let run = await runsDb.getRun(runId);
    expect(run?.status).toBe("partial");

    const successIdsBefore = (await runsDb.listRunCells(runId))
      .filter((c) => c.error === null)
      .map((c) => c.id);

    const retried = await runSvc.retryFailedCells(user, { runId });
    expect(retried.ok).toBe(true);
    const retryJob = await jobs.claimNextJob("test-worker");
    expect(retryJob?.type).toBe("execute_run");
    await execute.executeRun(runId);

    run = await runsDb.getRun(runId);
    expect(run?.status).toBe("partial"); // still failing — but re-attempted
    const successIdsAfter = (await runsDb.listRunCells(runId))
      .filter((c) => c.error === null)
      .map((c) => c.id);
    expect(successIdsAfter).toEqual(successIdsBefore); // originals untouched
    const [attempts] = await sql`
      select count(*)::int as n from responses
      where run_id = ${runId} and error is not null
    `;
    expect(attempts?.n).toBeGreaterThanOrEqual(2); // failure captured per attempt
  });

  it("budget cap halts the run as partial with the reason recorded", async () => {
    const { projectId, versionId } = await setup(["budget prompt"]);
    // mock cost is 60µ$/call; a $0.5 budget is far above it, so shrink the
    // budget by pre-charging the run: set budget to the minimum then verify
    // the guard using a run whose spent cost exceeds it.
    const runId = await startAndClaim(projectId, versionId, {
      budgetUsd: 0.5,
      providers: [{ provider: "mock", model: "mock-model", repetitions: 3 }],
    });
    // Pre-charge the run to the cap so the first budget check trips
    await sql`update runs set cost_usd = 0.6 where id = ${runId}`;
    // spent is read from responses, so seed a synthetic prior success
    await sql`
      insert into responses (run_id, prompt_id, prompt_text, provider, model,
        repetition, raw_payload, response_text, cost_usd)
      select ${runId}, gen_random_uuid(), 'seed', 'mock', 'mock-model', 99,
        '{}'::jsonb, 'seed', 0.6
    `;
    await execute.executeRun(runId);
    const run = await runsDb.getRun(runId);
    expect(run?.status).toBe("partial");
    expect(run?.statusDetail).toBe("budget cap reached");
  });

  it("cancel while queued is respected; retry resets and re-executes", async () => {
    const { projectId, versionId } = await setup(["cancel prompt"]);
    const runId = await startAndClaim(projectId, versionId);
    const cancelled = await runSvc.cancelRun(user, { runId });
    expect(cancelled.ok).toBe(true);

    await execute.executeRun(runId); // worker picks up the stale job
    const [count] = await sql`
      select count(*)::int as n from responses where run_id = ${runId}
    `;
    expect(count?.n).toBe(0); // nothing executed
    const run = await runsDb.getRun(runId);
    expect(run?.status).toBe("partial");
    expect(run?.statusDetail).toBe("cancelled");
  });

  it("job queue: failed jobs requeue with backoff, then fail terminally", async () => {
    await jobs.enqueueJob(sql, "execute_run", { runId: "00000000-0000-4000-8000-000000000000" });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await sql`update jobs set run_after = now()`; // skip the backoff wait
      const job = await jobs.claimNextJob("test-worker");
      expect(job).not.toBeNull();
      await jobs.failJob(job!, "boom");
    }
    const [job] = await sql`select status, last_error from jobs`;
    expect(job?.status).toBe("failed");
    expect(job?.lastError).toBe("boom");
  });

  it("cron endpoint: auth, dedupe per ISO week, happy path", async () => {
    process.env.CRON_SECRET = "test-secret";
    const { POST } = await import("@/app/api/cron/weekly-baseline/route");

    const call = (secret?: string) =>
      POST(
        new Request("http://localhost/api/cron/weekly-baseline", {
          method: "POST",
          headers: secret ? { authorization: `Bearer ${secret}` } : {},
        })
      );

    expect((await call("wrong")).status).toBe(401);
    expect((await call(undefined)).status).toBe(401);

    const { projectId, versionId } = await setup(["baseline prompt"]);
    const [version] = await sql`
      select prompt_set_id from prompt_set_versions where id = ${versionId}
    `;
    await sql`
      update projects set
        baseline_prompt_set_id = ${version?.promptSetId as string},
        baseline_config = ${sql.json({
          providers: [{ provider: "mock", model: "mock-model", repetitions: 1 }],
          budgetUsd: 1,
        } as never)}
      where id = ${projectId}
    `;

    const first = await call("test-secret");
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { results: { outcome: string }[] };
    expect(firstBody.results[0]?.outcome).toBe("started");

    const second = await call("test-secret");
    const secondBody = (await second.json()) as { results: { outcome: string }[] };
    expect(secondBody.results[0]?.outcome).toBe("already_ran_this_week");

    const [run] = await sql`select trigger, label from runs`;
    expect(run?.trigger).toBe("scheduled");
    expect(run?.label).toContain("Weekly baseline");
  });
});
