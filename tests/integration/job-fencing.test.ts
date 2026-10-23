/** Spec 151 C2: lease renewal and fenced completion over the real queue. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { truncateAll } from "../helpers/db";

const TEST_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_URL)("job lease fencing (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let jobs: typeof import("@/db/jobs");

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    jobs = await import("@/db/jobs");
  });
  afterAll(async () => {
    // A test kills a reserved connection; an unbounded end() would wait forever.
    await sql.end({ timeout: 5 });
  });
  beforeEach(async () => {
    await truncateAll(sql);
  });

  it("a reclaimed job cannot be completed by the worker that lost it", async () => {
    await jobs.enqueueJob(sql, "noop", {});
    const a = await jobs.claimNextJob("worker-a");
    expect(a).not.toBeNull();
    // Worker A stalls past the stale threshold; the sweep requeues; B claims.
    await sql`update jobs set locked_at = now() - interval '20 minutes' where id = ${a!.id}`;
    expect(await jobs.reclaimStaleJobs(15)).toBe(1);
    const b = await jobs.claimNextJob("worker-b");
    expect(b?.id).toBe(a!.id);

    expect(await jobs.renewLease(a!.id, "worker-a")).toBe(false);
    expect(await jobs.completeJob(a!.id, "worker-a")).toBe(false);
    expect(await jobs.failJob(a!, "late failure", "worker-a")).toBe(false);
    const [mid] = await sql`select status, locked_by from jobs where id = ${a!.id}`;
    expect(mid).toMatchObject({ status: "running", lockedBy: "worker-b" });

    expect(await jobs.renewLease(b!.id, "worker-b")).toBe(true);
    expect(await jobs.completeJob(b!.id, "worker-b")).toBe(true);
    const [done] = await sql`select status from jobs where id = ${a!.id}`;
    expect(done?.status).toBe("done");
  });

  it("renewal keeps a long-running job out of the stale sweep", async () => {
    await jobs.enqueueJob(sql, "noop", {});
    const a = await jobs.claimNextJob("worker-a");
    await sql`update jobs set locked_at = now() - interval '14 minutes' where id = ${a!.id}`;
    expect(await jobs.renewLease(a!.id, "worker-a")).toBe(true);
    expect(await jobs.reclaimStaleJobs(15)).toBe(0);
  });

  it("a reclaimed job that is still executing is never run twice; the holder settles it", async () => {
    const core = await import("@/workers/core");
    let calls = 0;
    core.handlers.test_slow = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 600));
    };
    try {
      const id = await jobs.enqueueJob(sql, "test_slow", {});
      const a = core.dispatchOnce("worker-a", { renewIntervalMs: 40 });
      await new Promise((r) => setTimeout(r, 100));
      // A's lease is (wrongly) judged stale and reclaimed; B claims it.
      await sql`update jobs set status = 'queued', locked_by = null, run_after = now() where id = ${id}`;
      const b = await core.dispatchOnce("worker-b", { renewIntervalMs: 40 });
      expect(b.status).toBe("deferred");
      const [mid] = await sql`select attempts from jobs where id = ${id}`;
      expect(mid?.attempts).toBe(1); // B's claim did not burn an attempt
      expect((await a).status).toBe("done");
      expect(calls).toBe(1);
      const [row] = await sql`select status from jobs where id = ${id}`;
      expect(row?.status).toBe("done");
      // B's deferred retry later finds it done and does nothing.
      await sql`update jobs set run_after = now() where id = ${id}`;
      expect((await core.dispatchOnce("worker-b")).status).toBe("idle");
      expect(calls).toBe(1);
    } finally {
      delete core.handlers.test_slow;
    }
  });

  it("a second executor for the same run returns without launching a cell", async () => {
    const { RUN_EXECUTION_LOCK_CLASS, executeRun } = await import("@/lib/runs/execute");
    const runId = "00000000-0000-4000-8000-0000000000ee";
    const holder = await sql.reserve();
    await holder`select pg_advisory_lock(${RUN_EXECUTION_LOCK_CLASS}, hashtext(${runId}))`;
    try {
      await executeRun(runId); // would throw not_found if it got past the lock
    } finally {
      await holder`select pg_advisory_unlock(${RUN_EXECUTION_LOCK_CLASS}, hashtext(${runId}))`;
      holder.release();
    }
    await expect(executeRun(runId)).rejects.toThrow(/not found/i);
  });

  it("executeRun launches nothing and does not finalize once its lease signal has fired", async () => {
    const { operatorUser } = await import("../helpers/actors");
    const user = operatorUser();
    const projectSvc = await import("@/lib/projects/service");
    const setSvc = await import("@/lib/prompts/set-service");
    const promptSvc = await import("@/lib/prompts/prompt-service");
    const runSvc = await import("@/lib/runs/service");
    const { executeRun } = await import("@/lib/runs/execute");
    const project = await projectSvc.createProject(user, { name: "Lease run" });
    if (!project.ok) throw new Error(project.error.message);
    const set = await setSvc.createPromptSet(user, { projectId: project.data.id, name: "S" });
    if (!set.ok) throw new Error(set.error.message);
    await promptSvc.addPrompt(user, { setId: set.data.id, text: "best tool?", category: "recommendation" });
    await setSvc.freezePromptSet(user, { id: set.data.id });
    const [version] = await sql`select id from prompt_set_versions where prompt_set_id = ${set.data.id}`;
    const started = await runSvc.startRun(user, {
      projectId: project.data.id,
      promptSetVersionId: version!.id,
      providers: [{ provider: "mock", model: "mock-model", repetitions: 3 }],
      budgetUsd: 1,
      label: "lease",
    });
    if (!started.ok) throw new Error(started.error.message);
    const lost = new AbortController();
    lost.abort();
    await executeRun(started.data.id, { signal: lost.signal });
    const [{ n }] = (await sql`select count(*)::int as n from responses where run_id = ${started.data.id}`) as unknown as [{ n: number }];
    expect(n).toBe(0);
    const [run] = await sql`select status, completed_at from runs where id = ${started.data.id}`;
    expect(run?.completedAt).toBeNull();
  });

  it("worker crash: killing the executor's lock connection releases the job to another worker, and the dead executor stands down", async () => {
    const core = await import("@/workers/core");
    let aborted = false;
    let runs = 0;
    core.handlers.test_crash = async (_payload, ctx) => {
      runs += 1;
      if (runs > 1) return; // the second executor finishes immediately
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 3000);
        ctx?.signal.addEventListener("abort", () => {
          aborted = true;
          clearTimeout(t);
          resolve();
        });
      });
    };
    try {
      const id = await jobs.enqueueJob(sql, "test_crash", {});
      const a = core.dispatchOnce("worker-a", { renewIntervalMs: 40 });
      await new Promise((r) => setTimeout(r, 120));
      // Simulate the executor's DB session dying (crash / network loss).
      const [lock] = await sql`
        select pid from pg_locks where locktype = 'advisory' and classid = 151 and objid = hashtext(${id})::oid and granted
      `.catch(() => [undefined]);
      const [byKey] = lock ? [lock] : await sql`
        select l.pid from pg_locks l where l.locktype = 'advisory' and l.classid = 151 and l.granted
      `;
      expect(byKey?.pid).toBeTruthy();
      await sql`select pg_terminate_backend(${byKey!.pid})`;
      const outcomeA = await a;
      expect(aborted).toBe(true);
      expect(outcomeA.status).toBe("failed");
      // Stale-lease sweep requeues it; worker B now gets the lock and runs it.
      await sql`update jobs set status = 'queued', locked_by = null, run_after = now() where id = ${id}`;
      expect((await core.dispatchOnce("worker-b")).status).toBe("done");
      expect(runs).toBe(2);
      const [row] = await sql`select status from jobs where id = ${id}`;
      expect(row?.status).toBe("done");
    } finally {
      delete core.handlers.test_crash;
    }
  });

  it("concurrent acquisition: two workers polling at once never claim the same job", async () => {
    const core = await import("@/workers/core");
    let runs = 0;
    core.handlers.test_once = async () => {
      runs += 1;
      await new Promise((r) => setTimeout(r, 100));
    };
    try {
      await jobs.enqueueJob(sql, "test_once", {});
      const outcomes = await Promise.all([core.dispatchOnce("worker-a"), core.dispatchOnce("worker-b")]);
      expect(outcomes.map((o) => o.status).sort()).toEqual(["done", "idle"]);
      expect(runs).toBe(1);
    } finally {
      delete core.handlers.test_once;
    }
  });

  it("scheduler overlap: a second worker skips the tick while one is ticking", async () => {
    const core = await import("@/workers/core");
    let release!: () => void;
    const first = core.withTickLock(() => new Promise<string>((r) => (release = () => r("ticked"))));
    await new Promise((r) => setTimeout(r, 50));
    expect(await core.withTickLock(async () => "second")).toEqual({ ran: false });
    release();
    expect(await first).toEqual({ ran: true, value: "ticked" });
    expect(await core.withTickLock(async () => "after")).toEqual({ ran: true, value: "after" });
  });

  it("a tick that throws still releases the lock", async () => {
    const core = await import("@/workers/core");
    await expect(core.withTickLock(async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(await core.withTickLock(async () => 1)).toEqual({ ran: true, value: 1 });
  });

  it("unfenced calls (no worker id) keep the old behavior", async () => {
    await jobs.enqueueJob(sql, "noop", {});
    const a = await jobs.claimNextJob("worker-a");
    expect(await jobs.completeJob(a!.id)).toBe(true);
  });
});
