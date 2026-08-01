/**
 * A5 (pilot-launch-plan): the execution substrate — job leases, stale-lease
 * reclaim, dead-lettering, and the worker's dispatch step — had zero test
 * coverage while everything it invokes was tested thoroughly. These are the
 * mechanisms that decide when work re-runs after a crash; a wrong predicate
 * here either strands jobs forever (silent stall) or re-fires a job that is
 * still running (double execution, including consequential work).
 *
 * Real Postgres: lease semantics are properties of the SQL, not the
 * TypeScript.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedTestActors } from "../helpers/actors";

const TEST_URL = process.env.TEST_DATABASE_URL;
const ROOT = join(__dirname, "..", "..");

describe.skipIf(!TEST_URL)("worker dispatch substrate (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let jobs: typeof import("@/db/jobs");
  let core: typeof import("@/workers/core");

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    jobs = await import("@/db/jobs");
    core = await import("@/workers/core");

    await sql.unsafe("drop schema public cascade; create schema public;");
    execSync(`npx tsx scripts/migrate.ts up --db "${TEST_URL}"`, { cwd: ROOT, stdio: "pipe" });
    await seedTestActors(sql);
  });

  beforeEach(async () => {
    await sql.unsafe("truncate jobs, notifications cascade");
  });

  afterAll(async () => {
    await sql.end();
  });

  async function insertJob(args: {
    type: string;
    status?: string;
    lockedAgoMinutes?: number;
    attempts?: number;
  }): Promise<string> {
    const [row] = await sql`
      insert into jobs (type, payload, status, attempts, locked_by, locked_at)
      values (
        ${args.type}, '{}', ${args.status ?? "queued"}, ${args.attempts ?? 0},
        ${args.lockedAgoMinutes !== undefined ? "dead-worker" : null},
        ${
          args.lockedAgoMinutes !== undefined
            ? sql`now() - make_interval(mins => ${args.lockedAgoMinutes})`
            : null
        }
      )
      returning id
    `;
    return row!.id as string;
  }

  // ------------------------------------------------ stale-lease reclaim

  it("reclaims a lease whose worker died, and the job becomes claimable again", async () => {
    const jobId = await insertJob({
      type: "sync_notifications",
      status: "running",
      lockedAgoMinutes: 20,
      attempts: 1,
    });

    const reclaimed = await jobs.reclaimStaleJobs(15);
    expect(reclaimed).toBe(1);

    const [row] = await sql`select status, locked_by from jobs where id = ${jobId}`;
    expect(row!.status).toBe("queued");
    expect(row!.lockedBy).toBeNull();

    // And it is genuinely re-offered — not stranded.
    const claimed = await jobs.claimNextJob("test-worker-2");
    expect(claimed?.id).toBe(jobId);
    expect(claimed?.attempts).toBe(2);
  });

  it("does NOT reclaim a fresh lease — a running job is not re-fired", async () => {
    await insertJob({
      type: "sync_notifications",
      status: "running",
      lockedAgoMinutes: 1,
      attempts: 1,
    });

    const reclaimed = await jobs.reclaimStaleJobs(15);
    expect(reclaimed).toBe(0);

    // Nothing to claim either: the lease is honoured while its worker lives.
    expect(await jobs.claimNextJob("test-worker-2")).toBeNull();
  });

  it("never double-claims: a claimed job is invisible to a second worker", async () => {
    await insertJob({ type: "sync_notifications" });

    const first = await jobs.claimNextJob("worker-a");
    expect(first).not.toBeNull();
    expect(await jobs.claimNextJob("worker-b")).toBeNull();
  });

  it("reclaim + re-claim re-runs the SAME job row — no duplicate is minted", async () => {
    const jobId = await insertJob({ type: "sync_notifications" });

    const first = await jobs.claimNextJob("worker-a");
    expect(first?.id).toBe(jobId);
    // worker-a dies here: no completeJob, lease goes stale.
    await sql`update jobs set locked_at = now() - interval '20 minutes' where id = ${jobId}`;

    await jobs.reclaimStaleJobs(15);
    const second = await jobs.claimNextJob("worker-b");
    expect(second?.id).toBe(jobId);

    const [countRow] = await sql`select count(*)::int as count from jobs`;
    expect(Number(countRow!.count)).toBe(1);
  });

  // ------------------------------------------------ failure & dead-letter

  it("requeues a failed job with backoff, then dead-letters at the attempt cap", async () => {
    await insertJob({ type: "definitely_unknown_type" });

    // Attempt 1: unknown handler → failed → requeued with future run_after.
    const first = await core.dispatchOnce("test-worker");
    expect(first.status).toBe("failed");
    let [row] = await sql`select status, run_after, attempts from jobs`;
    expect(row!.status).toBe("queued");
    expect(new Date(row!.runAfter as string).getTime()).toBeGreaterThan(Date.now());

    // Attempts 2 and 3 (cap): fast-forward the backoff each time.
    for (let i = 0; i < 2; i += 1) {
      await sql`update jobs set run_after = now()`;
      await core.dispatchOnce("test-worker");
    }

    [row] = await sql`select status, attempts, last_error from jobs`;
    expect(row!.status).toBe("failed"); // dead-lettered, visible, final
    expect(Number(row!.attempts)).toBe(3);
    expect(String(row!.lastError)).toContain("No handler");
  });

  // ------------------------------------------------ the dispatch seam

  it("dispatchOnce drives a real handler end-to-end and settles the job done", async () => {
    // sync_notifications derives from live tables; on an empty database it is
    // a no-op — which is exactly what makes it a safe real-handler probe.
    const jobId = await insertJob({ type: "sync_notifications" });

    const outcome = await core.dispatchOnce("test-worker");
    expect(outcome).toEqual({ status: "done", jobId, type: "sync_notifications" });

    const [row] = await sql`select status, locked_by from jobs where id = ${jobId}`;
    expect(row!.status).toBe("done");
    expect(row!.lockedBy).toBeNull();
  });

  it("dispatchOnce reports idle on an empty queue and on not-yet-due jobs", async () => {
    expect(await core.dispatchOnce("test-worker")).toEqual({ status: "idle" });

    await sql`
      insert into jobs (type, payload, run_after)
      values ('sync_notifications', '{}', now() + interval '1 hour')
    `;
    expect(await core.dispatchOnce("test-worker")).toEqual({ status: "idle" });
  });

  // ------------------------------------------------ system principal (B3)

  it("provides an active system principal after migrations", async () => {
    const auth = await import("@/lib/auth");
    const user = await auth.systemUser();
    expect(user.id).toBe(auth.SYSTEM_USER_ID);
    expect(user.role).toBe("operator");
    expect(user.email).toBe("system@parva.internal");
  });

  it("keeps session lookups out of worker-reachable code", async () => {
    // getCurrentUser needs request context: in a worker it throws under
    // AUTH_MODE=supabase and silently impersonates the dev admin under dev.
    // Background code must act as systemUser() instead — enforced here the
    // same way connector-security enforces its import boundary.
    const { readFile } = await import("node:fs/promises");
    for (const file of [
      "workers/core.ts",
      "workers/index.ts",
      "lib/cycles/service.ts",
      "lib/workflow/templates/content-production.ts",
    ]) {
      const source = await readFile(join(ROOT, file), "utf8");
      expect(source.includes("getCurrentUser"), `${file} must not use getCurrentUser`).toBe(
        false
      );
    }
  });

  it("registers a handler for every job type the codebase enqueues", async () => {
    // The worker's handler map is load-bearing configuration: a job type
    // enqueued anywhere but missing here dead-letters after 3 attempts.
    const enqueued = [
      "execute_run",
      "parse_response",
      "compute_scores",
      "start_scheduled_run",
      "sync_notifications",
      "discover_client_site",
      "analyze_gaps",
      "analyze_accuracy",
      "extract_claims",
      "advance_cycle",
      "knowledge_build",
      "advance_workflow",
      "build_evidence_export",
      "deliver_events",
      "sweep_event_delivery",
      "dispatch_triggers",
      "connector_health_sweep",
    ];
    for (const type of enqueued) {
      expect(core.handlers[type], `missing handler: ${type}`).toBeTypeOf("function");
    }
  });
});
