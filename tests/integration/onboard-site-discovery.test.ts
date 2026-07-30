/**
 * Onboarding queues a site crawl (spec 021 follow-up).
 *
 * The property that matters is the one that is easy to lose in a refactor:
 * onboarding must NOT wait on, or fail because of, a prospect's website. It
 * queues the crawl and returns. These tests exercise the queueing decision, not
 * the network — the crawler itself is covered by tests/unit/site-discovery.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { seedTestActors } from "../helpers/actors";

const TEST_URL = process.env.TEST_DATABASE_URL;
const ROOT = join(__dirname, "..", "..");

const user: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000601",
  email: "op@test.local",
  name: "Operator",
  role: "admin",
};

describe.skipIf(!TEST_URL)("onboarding queues site discovery (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let onboarding: typeof import("@/lib/verticals/onboarding");

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    onboarding = await import("@/lib/verticals/onboarding");
    await sql.unsafe("drop schema public cascade; create schema public;");
    execSync(`npx tsx scripts/migrate.ts up --db "${TEST_URL}"`, { cwd: ROOT, stdio: "pipe" });
    await seedTestActors(sql);
  }, 180_000);

  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    await sql.unsafe(`
      truncate jobs, source_artifacts, competitors, claims, evidence, prompts,
        prompt_set_versions, prompt_sets, companies, vertical_packs, audit_log,
        projects restart identity cascade
    `);
  });

  function input(overrides: Record<string, unknown> = {}) {
    return {
      clientName: `Client ${Math.random().toString(36).slice(2, 8)}`,
      packKey: "real-estate-agent",
      company: { name: "Test Realty", aliases: [], domain: "example.com" },
      variables: {
        market: ["Jersey City"],
        clientType: ["sellers"],
      },
      facts: [],
      competitors: [],
      ...overrides,
    };
  }

  it("queues a crawl for a client with a domain", async () => {
    const result = await onboarding.onboardClient(user, input());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.siteDiscoveryQueued).toBe(true);

    const [job] = await sql`
      select type, payload, status from jobs where type = 'discover_client_site'
    `;
    expect(job).toBeDefined();
    expect(job!.status).toBe("queued");
    expect((job!.payload as { domain: string }).domain).toBe("example.com");
    expect((job!.payload as { projectId: string }).projectId).toBe(result.data.projectId);
    // Attribution matters: these artifacts land in an audit trail.
    expect((job!.payload as { createdBy: string }).createdBy).toBe(user.id);
  });

  it("onboards without a domain and says no crawl was queued", async () => {
    const result = await onboarding.onboardClient(
      user,
      input({ company: { name: "No Website Co", aliases: [], domain: null } })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Not an error — plenty of prospects have no site worth crawling. But it
    // is reported, so nobody waits for artifacts that were never coming.
    expect(result.data.siteDiscoveryQueued).toBe(false);
    expect(await sql`select id from jobs where type = 'discover_client_site'`).toHaveLength(0);
  });

  it("returns before the crawl runs — onboarding never waits on a website", async () => {
    const result = await onboarding.onboardClient(user, input());
    if (!result.ok) throw new Error("onboarding failed");

    // The job is still queued and nothing has been fetched. If onboarding ever
    // starts awaiting the crawl, a slow or gated prospect site becomes a failed
    // onboarding, and this is the assertion that catches it.
    const [job] = await sql`select status from jobs where type = 'discover_client_site'`;
    expect(job!.status).toBe("queued");
    const artifacts = await sql`
      select id from source_artifacts where project_id = ${result.data.projectId}
    `;
    expect(artifacts).toHaveLength(0);
  });

  it("still completes onboarding fully when a crawl is queued", async () => {
    const result = await onboarding.onboardClient(user, input());
    if (!result.ok) throw new Error("onboarding failed");
    // The crawl is additive; it must not change what onboarding produces.
    expect(result.data.promptsCreated).toBeGreaterThan(0);
    expect(result.data.projectId).toBeTruthy();
    expect(result.data.promptSetId).toBeTruthy();
  });
});
