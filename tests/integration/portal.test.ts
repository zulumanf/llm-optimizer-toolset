/**
 * Spec 031: the portal is a strict subset. Internal-only tasks and draft
 * reports are filtered in SQL — provably absent from what a client reads.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { seedTestActors } from "../helpers/actors";

const TEST_URL = process.env.TEST_DATABASE_URL;
const ROOT = join(__dirname, "..", "..");

const user: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000701",
  email: "op@test.local",
  name: "Operator",
  role: "operator",
};

describe.skipIf(!TEST_URL)("client portal (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let portal: typeof import("@/lib/portal/service");
  let projectSvc: typeof import("@/lib/projects/service");
  let companySvc: typeof import("@/lib/companies/service");
  let claimsSvc: typeof import("@/lib/claims/service");
  let setSvc: typeof import("@/lib/prompts/set-service");
  let promptSvc: typeof import("@/lib/prompts/prompt-service");
  let runSvc: typeof import("@/lib/runs/service");
  let tasksSvc: typeof import("@/lib/tasks/service");
  let jobs: typeof import("@/db/jobs");
  let execute: typeof import("@/lib/runs/execute");
  let parsing: typeof import("@/lib/parsing/service");
  let scoring: typeof import("@/lib/scoring/compute");

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    portal = await import("@/lib/portal/service");
    projectSvc = await import("@/lib/projects/service");
    companySvc = await import("@/lib/companies/service");
    claimsSvc = await import("@/lib/claims/service");
    setSvc = await import("@/lib/prompts/set-service");
    promptSvc = await import("@/lib/prompts/prompt-service");
    runSvc = await import("@/lib/runs/service");
    tasksSvc = await import("@/lib/tasks/service");
    jobs = await import("@/db/jobs");
    execute = await import("@/lib/runs/execute");
    parsing = await import("@/lib/parsing/service");
    scoring = await import("@/lib/scoring/compute");
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
      truncate reports, interventions, tasks, evidence, jobs, scores,
        response_parses, mentions, sources, response_citations,
        brand_candidates, responses, runs, prompt_set_versions, prompts,
        prompt_sets, companies, audit_log, domain_events, projects cascade
    `);
  });

  async function drainJobs(): Promise<void> {
    for (let i = 0; i < 100; i += 1) {
      const job = await jobs.claimNextJob("test-worker");
      if (!job) return;
      if (job.type === "execute_run")
        await execute.executeRun(job.payload.runId as string);
      else if (job.type === "parse_response")
        await parsing.parseResponse(job.payload.responseId as string);
      else if (job.type === "compute_scores")
        await scoring.computeScores(job.payload.runId as string);
      await jobs.completeJob(job.id);
    }
  }

  it("overview, work, and reports expose only the client-safe subset", async () => {
    const company = await companySvc.upsertCompany(user, { name: "Lumina" });
    if (!company.ok) throw new Error(company.error.message);
    const project = await projectSvc.createProject(user, { name: "Portal Co" });
    if (!project.ok) throw new Error(project.error.message);
    const projectId = project.data.id;
    await claimsSvc.setSubjectCompany(user, {
      projectId,
      companyId: company.data.id,
    });
    const set = await setSvc.createPromptSet(user, { projectId, name: "Set" });
    if (!set.ok) throw new Error(set.error.message);
    await promptSvc.addPrompt(user, {
      setId: set.data.id,
      text: "best tools?",
      category: "recommendation",
    });
    await setSvc.freezePromptSet(user, { id: set.data.id });
    const [version] = await sql`
      select id from prompt_set_versions where prompt_set_id = ${set.data.id}
    `;
    const started = await runSvc.startRun(user, {
      projectId,
      promptSetVersionId: version?.id as string,
      providers: [{ provider: "mock", model: "mock-model", repetitions: 2 }],
      budgetUsd: 5,
      label: "portal run",
    });
    if (!started.ok) throw new Error(started.error.message);
    await drainJobs();

    // Overview: headline metrics with sample sizes and scoring version.
    const overview = await portal.portalOverview(projectId);
    expect(overview.subjectName).toBe("Lumina");
    const mention = overview.headlines.find((h) => h.metric === "mention_rate");
    expect(mention?.value).toBe(1);
    expect(mention?.sampleSize).toBe(2);
    expect(mention?.scoringVersion).toBeTruthy();

    // Two done tasks: one shared with the client, one internal.
    const [response] = await sql`select id from responses limit 1`;
    async function doneTask(title: string, clientVisible: boolean) {
      const t = await tasksSvc.suggestTask(user, {
        projectId,
        title,
        evidence: [
          { kind: "response", refId: response?.id as string, note: "seed" },
        ],
      });
      if (!t.ok) throw new Error(t.error.message);
      await tasksSvc.approveTask(user, { taskId: t.data.taskId });
      await tasksSvc.completeTask(user, { taskId: t.data.taskId });
      await tasksSvc.updateTaskDetails(user, {
        taskId: t.data.taskId,
        clientVisible,
      });
    }
    await doneTask("Shared work item", true);
    await doneTask("Internal only item", false);

    const work = await portal.portalWork(projectId);
    const titles = work.map((w) => w.title);
    expect(titles).toContain("Shared work item");
    expect(titles).not.toContain("Internal only item");

    // Reports: published only.
    await sql`
      insert into reports (project_id, title, period_start, period_end, body,
        status, published_at)
      values
        (${projectId}, 'Draft report', '2026-07-01', '2026-07-28',
          '{}'::jsonb, 'draft', null),
        (${projectId}, 'July report', '2026-07-01', '2026-07-28',
          '{}'::jsonb, 'published', now())
    `;
    const reports = await portal.portalReports(projectId);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.title).toBe("July report");
  });

  it("no subject or no runs renders honest emptiness, not errors", async () => {
    const project = await projectSvc.createProject(user, { name: "Empty Co" });
    if (!project.ok) throw new Error(project.error.message);
    const overview = await portal.portalOverview(project.data.id);
    expect(overview.subjectName).toBeNull();
    expect(overview.headlines).toHaveLength(0);
    expect(await portal.portalWork(project.data.id)).toHaveLength(0);
    expect(await portal.portalReports(project.data.id)).toHaveLength(0);
  });


  it("refuses under dev auth, non-admins, and staff-email collisions", async () => {
    const { sql } = await import("@/db/client");
    const invite = await import("@/lib/portal/invite");
    const projectSvc = await import("@/lib/projects/service");
    const admin: CurrentUser = { ...user, role: "admin" };

    const project = await projectSvc.createProject(admin, { name: "Invite Co" });
    if (!project.ok) throw new Error(project.error.message);

    // Operator (non-admin) is refused before anything else.
    const asOperator = await invite.inviteClientViewer(user, {
      projectId: project.data.id,
      email: "client@example.com",
      name: "Client",
    });
    expect(asOperator.ok).toBe(false);
    if (!asOperator.ok) expect(asOperator.error.kind).toBe("forbidden");

    // Under dev auth there is no identity provider to invite into.
    const devMode = await invite.inviteClientViewer(admin, {
      projectId: project.data.id,
      email: "client@example.com",
      name: "Client",
    });
    expect(devMode.ok).toBe(false);
    if (!devMode.ok) expect(devMode.error.message).toMatch(/AUTH_MODE=supabase/);

    // A staff email is never converted into a client account.
    await sql`
      insert into users (id, email, name, role)
      values ('00000000-0000-4000-8000-00000000f001', 'staff@avos.local',
        'Staff Member', 'operator')
      on conflict (id) do nothing
    `;
    const collision = await invite.inviteClientViewer(admin, {
      projectId: project.data.id,
      email: "staff@avos.local",
      name: "X",
    });
    expect(collision.ok).toBe(false);
    if (!collision.ok) expect(collision.error.message).toMatch(/non-client/);

    // Granting an EXISTING client account works in any auth mode.
    await sql`
      insert into users (id, email, name, role)
      values ('00000000-0000-4000-8000-00000000f002', 'existing@client.com',
        'Existing Client', 'client_viewer')
      on conflict (id) do nothing
    `;
    const granted = await invite.inviteClientViewer(admin, {
      projectId: project.data.id,
      email: "existing@client.com",
      name: "Existing Client",
    });
    expect(granted.ok).toBe(true);
    if (granted.ok) expect(granted.data.existing).toBe(true);
    const [grant] = await sql`
      select 1 from user_project_access
      where user_id = '00000000-0000-4000-8000-00000000f002'
        and project_id = ${project.data.id}
    `;
    expect(grant).toBeDefined();
  });
});
