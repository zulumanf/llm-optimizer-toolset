/**
 * Spec 059: the worker's pulse, the health report, the two-audience health
 * endpoint, and alert dedupe — against real Postgres.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_URL = process.env.TEST_DATABASE_URL;
const ROOT = join(__dirname, "..", "..");

describe.skipIf(!TEST_URL)("ops liveness (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let health: typeof import("@/lib/ops/health");
  let alerts: typeof import("@/lib/ops/alerts");

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    health = await import("@/lib/ops/health");
    alerts = await import("@/lib/ops/alerts");
    await sql.unsafe("drop schema public cascade; create schema public;");
    execSync(`npx tsx scripts/migrate.ts up --db "${TEST_URL}"`, {
      cwd: ROOT,
      stdio: "pipe",
    });
  });

  beforeEach(async () => {
    await sql.unsafe("truncate worker_heartbeats, ops_alerts, jobs, drift_signals");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await sql.end();
  });

  it("a beating worker reads alive; a stale one flips the report", async () => {
    const before = await health.healthReport();
    expect(before.db).toBe(true);
    expect(before.worker.alive).toBe(false);
    expect(before.ok).toBe(false);

    await health.beatHeartbeat("w-test", 3);
    const alive = await health.healthReport();
    expect(alive.worker.alive).toBe(true);
    expect(alive.ok).toBe(true);
    expect(alive.worker.workerId).toBe("w-test");

    // Age the pulse past the staleness threshold (ops state is mutable).
    await sql`
      update worker_heartbeats set last_seen_at = now() - interval '10 minutes'
    `;
    const stale = await health.healthReport();
    expect(stale.worker.alive).toBe(false);
    expect(stale.ok).toBe(false);
  });

  it("overdue queued jobs surface in the report", async () => {
    await health.beatHeartbeat("w-test", 0);
    await sql`
      insert into jobs (type, payload, run_after, created_at)
      values ('compute_scores', '{}', now() - interval '30 minutes',
        now() - interval '30 minutes')
    `;
    const report = await health.healthReport();
    expect(report.queue.queued).toBe(1);
    expect(report.queue.overdue).toBe(1);
    expect(report.queue.oldestQueuedMinutes).toBeGreaterThanOrEqual(29);
  });

  it("the health route serves both audiences: minimal shape vs full report", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret-s3cret-s3cret");
    await health.beatHeartbeat("w-test", 0);
    const { GET } = await import("@/app/api/health/route");

    const anonymous = await GET(new Request("http://x/api/health"));
    expect(anonymous.status).toBe(200);
    const minimal = await anonymous.json();
    expect(Object.keys(minimal).sort()).toEqual(["db", "ok", "worker"]);
    expect(minimal.worker).toBe(true);

    const authed = await GET(
      new Request("http://x/api/health", {
        headers: { authorization: "Bearer s3cret-s3cret-s3cret" },
      })
    );
    const full = await authed.json();
    expect(full.queue).toBeDefined();
    expect(full.spend.ceilingUsd).toBeGreaterThan(0);

    // Dead worker → 503 for the platform health check.
    await sql`update worker_heartbeats set last_seen_at = now() - interval '1 hour'`;
    const dead = await GET(new Request("http://x/api/health"));
    expect(dead.status).toBe(503);
  });

  it("alerts post once per window per kind, then re-arm", async () => {
    // No heartbeat → worker_stale fires.
    const posts: string[] = [];
    vi.stubEnv("DIGEST_WEBHOOK_URL", "https://hooks.example/avos");
    const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      posts.push(String(init?.body ?? ""));
      return new Response("ok");
    }) as typeof fetch;

    const first = await alerts.dispatchSystemAlerts({ fetchImpl });
    expect(first.firing.map((a) => a.kind)).toContain("worker_stale");
    expect(first.sent).toContain("worker_stale");
    expect(posts.some((p) => p.includes("worker_stale"))).toBe(true);

    // Second tick inside the window: still firing, not re-sent.
    const second = await alerts.dispatchSystemAlerts({ fetchImpl });
    expect(second.firing.map((a) => a.kind)).toContain("worker_stale");
    expect(second.sent).not.toContain("worker_stale");

    // Window elapses → re-arms.
    await sql`
      update ops_alerts set last_sent_at = now() - interval '2 hours'
      where kind = 'worker_stale'
    `;
    const third = await alerts.dispatchSystemAlerts({ fetchImpl });
    expect(third.sent).toContain("worker_stale");
  });

  it(".env.example documents the once-stray variables the audit found", async () => {
    const { readFileSync } = await import("node:fs");
    const example = readFileSync(join(ROOT, ".env.example"), "utf8");
    for (const key of [
      "APP_URL",
      "DIGEST_WEBHOOK_URL",
      "MCP_USER_ID",
      "DAILY_SPEND_CEILING_USD",
      "COMMISSION_RATE_ESTIMATE",
      "SENDER_COMPANY",
      "ALLOW_MOCK_SCORING",
      "BACKUP_ENCRYPTION_KEY",
      "BACKUP_UPLOAD_CMD",
    ]) {
      expect(example, `${key} missing from .env.example`).toContain(key);
    }
  });
});
