/**
 * Spec 029 acceptance: baseline capture at activation (and refusal without
 * a scored run), member tenant integrity, client denial, audit rows.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { seedTestActors } from "../helpers/actors";

const TEST_URL = process.env.TEST_DATABASE_URL;
const ROOT = join(__dirname, "..", "..");

const user: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000401",
  email: "op@test.local",
  name: "Operator",
  role: "operator",
};
const client: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000402",
  email: "client@example.com",
  name: "Client Viewer",
  role: "client_viewer",
};

describe.skipIf(!TEST_URL)("campaigns (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let svc: typeof import("@/lib/campaigns/service");
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
    svc = await import("@/lib/campaigns/service");
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
      truncate campaign_members, campaigns, audit_log, jobs, tasks, evidence,
        response_citations, scores, response_parses, mentions, sources,
        brand_candidates, companies, responses, runs, prompt_set_versions,
        prompts, prompt_sets, projects cascade
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

  async function seedProject(name: string, opts?: { scoredRun?: boolean }) {
    const company = await companySvc.upsertCompany(user, { name: `${name} Co` });
    if (!company.ok) throw new Error(company.error.message);
    const project = await projectSvc.createProject(user, { name });
    if (!project.ok) throw new Error(project.error.message);
    await claimsSvc.setSubjectCompany(user, {
      projectId: project.data.id,
      companyId: company.data.id,
    });
    if (opts?.scoredRun) {
      const set = await setSvc.createPromptSet(user, {
        projectId: project.data.id,
        name: "Set",
      });
      if (!set.ok) throw new Error(set.error.message);
      await promptSvc.addPrompt(user, {
        setId: set.data.id,
        text: `best tools like ${name} Co?`,
        category: "recommendation",
      });
      await setSvc.freezePromptSet(user, { id: set.data.id });
      const [version] = await sql`
        select id from prompt_set_versions where prompt_set_id = ${set.data.id}
      `;
      const started = await runSvc.startRun(user, {
        projectId: project.data.id,
        promptSetVersionId: version?.id as string,
        providers: [{ provider: "mock", model: "mock-model", repetitions: 2 }],
        budgetUsd: 5,
        label: "baseline",
      });
      if (!started.ok) throw new Error(started.error.message);
      await drainJobs();
    }
    return project.data.id;
  }

  it("activation refuses without a scored run, then captures a baseline", async () => {
    const bare = await seedProject("Bare Client");
    const created = await svc.createCampaign(user, {
      projectId: bare,
      name: "Visibility push",
      objective: "Get recommended.",
      targetMetrics: [{ metric: "mention_rate", target: 80 }],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const refused = await svc.transitionCampaign(user, {
      campaignId: created.data.campaignId,
      action: "activate",
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toMatch(/scored run/i);

    const scored = await seedProject("Scored Client", { scoredRun: true });
    const campaign = await svc.createCampaign(user, {
      projectId: scored,
      name: "Visibility push 2",
      objective: "Get recommended.",
      targetMetrics: [{ metric: "mention_rate", target: 80 }],
    });
    if (!campaign.ok) throw new Error(campaign.error.message);
    const activated = await svc.transitionCampaign(user, {
      campaignId: campaign.data.campaignId,
      action: "activate",
    });
    expect(activated.ok).toBe(true);

    const detail = await svc.campaignDetail(campaign.data.campaignId);
    expect(detail?.status).toBe("active");
    expect(detail?.baseline?.runId).toBeTruthy();
    expect(detail?.baseline?.scoringVersion).toBeTruthy();
    expect(
      detail?.baseline?.metrics.find((m) => m.metric === "mention_rate")
    ).toBeDefined();
    // Current run IS the baseline run → comparable, delta exactly 0.
    const progress = detail?.progress[0];
    expect(progress?.comparable).toBe(true);
    expect(progress?.delta).toBe(0);
  });

  it("rejects members from another client, accepts same-project members", async () => {
    const projectA = await seedProject("Client A", { scoredRun: true });
    const projectB = await seedProject("Client B");

    const campaign = await svc.createCampaign(user, {
      projectId: projectA,
      name: "A campaign",
      objective: "Win A's market.",
    });
    if (!campaign.ok) throw new Error(campaign.error.message);

    const [responseA] = await sql`
      select r.id from responses r join runs ru on ru.id = r.run_id
      where ru.project_id = ${projectA} limit 1
    `;
    const taskA = await tasksSvc.suggestTask(user, {
      projectId: projectA,
      title: "A task",
      evidence: [
        { kind: "response", refId: responseA?.id as string, note: "seed" },
      ],
    });
    if (!taskA.ok) throw new Error(taskA.error.message);
    const [responseA2] = await sql`
      select r.id from responses r join runs ru on ru.id = r.run_id
      where ru.project_id = ${projectA} limit 1
    `;
    const taskB = await tasksSvc.suggestTask(user, {
      projectId: projectB,
      title: "B task",
      evidence: [
        { kind: "response", refId: responseA2?.id as string, note: "seed" },
      ],
    });
    if (!taskB.ok) throw new Error(taskB.error.message);

    const good = await svc.addCampaignMember(user, {
      campaignId: campaign.data.campaignId,
      kind: "task",
      refId: taskA.data.taskId,
    });
    expect(good.ok).toBe(true);

    const bad = await svc.addCampaignMember(user, {
      campaignId: campaign.data.campaignId,
      kind: "task",
      refId: taskB.data.taskId,
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.message).toMatch(/different client/i);

    const detail = await svc.campaignDetail(campaign.data.campaignId);
    expect(detail?.members).toHaveLength(1);
    expect(detail?.members[0]?.title).toBe("A task");
  });

  it("denies client accounts and writes audit rows for staff actions", async () => {
    const projectId = await seedProject("Audited Client");
    const denied = await svc.createCampaign(client, {
      projectId,
      name: "X",
      objective: "Y.",
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.kind).toBe("forbidden");

    const created = await svc.createCampaign(user, {
      projectId,
      name: "Audited",
      objective: "Audit me.",
    });
    expect(created.ok).toBe(true);
    const [audit] = await sql`
      select 1 from audit_log where action = 'campaign.create'
    `;
    expect(audit).toBeDefined();
  });
});
