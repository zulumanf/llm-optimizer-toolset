/**
 * Spec 027 wiring — the product entry point for external discovery:
 * request → dedupe → audited enqueue → worker handler → recorded run.
 * Keyless environment by design (tests/setup.ts strips provider keys), so
 * the live search path fails gracefully per query and the run completes
 * with zero candidates — the dispatch plumbing is what's under test, not
 * the crawl.
 */
import { execSync } from "node:child_process";
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

describe.skipIf(!TEST_URL)("external discovery request (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let request: typeof import("@/lib/knowledge/discovery/request");
  let core: typeof import("@/workers/core");
  let jobs: typeof import("@/db/jobs");
  let discovery: typeof import("@/db/discovery");
  let projectSvc: typeof import("@/lib/projects/service");
  let companySvc: typeof import("@/lib/companies/service");
  let claimSvc: typeof import("@/lib/claims/service");

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    request = await import("@/lib/knowledge/discovery/request");
    core = await import("@/workers/core");
    jobs = await import("@/db/jobs");
    discovery = await import("@/db/discovery");
    projectSvc = await import("@/lib/projects/service");
    companySvc = await import("@/lib/companies/service");
    claimSvc = await import("@/lib/claims/service");
    await sql.unsafe("drop schema public cascade; create schema public;");
    execSync(`npx tsx scripts/migrate.ts up --db "${TEST_URL}"`, {
      cwd: ROOT,
      stdio: "pipe",
    });
    await seedTestActors(sql);
  });

  beforeEach(async () => {
    await sql.unsafe(
      "truncate audit_log, jobs, discovery_candidates, discovery_runs, companies, projects cascade"
    );
  });

  afterAll(async () => {
    await sql.end();
  });

  async function seedProject(): Promise<string> {
    const company = await companySvc.upsertCompany(user, {
      name: "Lumina",
      isSelf: true,
    });
    if (!company.ok) throw new Error(company.error.message);
    const project = await projectSvc.createProject(user, { name: "Discovery Test" });
    if (!project.ok) throw new Error(project.error.message);
    const subject = await claimSvc.setSubjectCompany(user, {
      projectId: project.data.id,
      companyId: company.data.id,
    });
    if (!subject.ok) throw new Error(subject.error.message);
    return project.data.id;
  }

  it("enqueues one audited job; a second request while in flight is a conflict", async () => {
    const projectId = await seedProject();

    const first = await request.requestExternalDiscovery(user, { projectId });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const [job] = await sql`
      select type, status, payload from jobs where id = ${first.data.jobId}
    `;
    expect(job?.type).toBe("external_discovery");
    expect(job?.status).toBe("queued");
    expect((job?.payload as { requestedBy: string }).requestedBy).toBe(user.id);

    const [audit] = await sql`
      select action, user_id from audit_log
      where action = 'discovery.requested' and entity_id = ${projectId}
    `;
    expect(audit?.userId).toBe(user.id);

    const second = await request.requestExternalDiscovery(user, { projectId });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.kind).toBe("conflict");
  });

  it("refuses a project with no subject company at request time", async () => {
    const project = await projectSvc.createProject(user, { name: "No Subject" });
    if (!project.ok) throw new Error(project.error.message);
    const result = await request.requestExternalDiscovery(user, {
      projectId: project.data.id,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("conflict");
      expect(result.error.message).toContain("subject company");
    }
  });

  it("refuses archived and unknown projects", async () => {
    const projectId = await seedProject();
    await sql`update projects set status = 'archived' where id = ${projectId}`;
    const archived = await request.requestExternalDiscovery(user, { projectId });
    expect(archived.ok).toBe(false);
    if (!archived.ok) expect(archived.error.kind).toBe("conflict");

    const missing = await request.requestExternalDiscovery(user, {
      projectId: "33333333-3333-4333-8333-333333333333",
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.kind).toBe("not_found");
  });

  it("the worker handler records a discovery run and frees the slot", async () => {
    const projectId = await seedProject();
    const requested = await request.requestExternalDiscovery(user, { projectId });
    expect(requested.ok).toBe(true);

    const job = await jobs.claimNextJob("test-worker");
    expect(job?.type).toBe("external_discovery");
    await core.handlers.external_discovery!(job!.payload);
    await jobs.completeJob(job!.id);

    const runs = await discovery.listDiscoveryRuns(projectId);
    expect(runs).toHaveLength(1);
    // Keyless: every templated search failed gracefully → zero candidates,
    // run settles rather than pretending it found an empty web.
    expect(runs[0]?.candidatesFound).toBe(0);
    expect(["completed", "partial", "safely_stopped", "failed"]).toContain(
      runs[0]?.status
    );

    // Slot freed: a new request is accepted once nothing is in flight.
    const again = await request.requestExternalDiscovery(user, { projectId });
    expect(again.ok).toBe(true);
  });
});
