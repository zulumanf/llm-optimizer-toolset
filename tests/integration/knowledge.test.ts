/**
 * Integration tests for spec 008 — per-project subjects (no cross-client
 * talk) and the verified claims register.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { seedTestActors } from "../helpers/actors";

const TEST_URL = process.env.TEST_DATABASE_URL;
const ROOT = join(__dirname, "..", "..");

const user: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000301",
  email: "op@test.local",
  name: "Operator",
  role: "operator",
};

describe.skipIf(!TEST_URL)("client knowledge (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let projectSvc: typeof import("@/lib/projects/service");
  let setSvc: typeof import("@/lib/prompts/set-service");
  let promptSvc: typeof import("@/lib/prompts/prompt-service");
  let runSvc: typeof import("@/lib/runs/service");
  let execute: typeof import("@/lib/runs/execute");
  let jobs: typeof import("@/db/jobs");
  let companySvc: typeof import("@/lib/companies/service");
  let claims: typeof import("@/lib/claims/service");
  let parsing: typeof import("@/lib/parsing/service");
  let scoring: typeof import("@/lib/scoring/compute");
  let mock: typeof import("@/lib/ai/mock");

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    projectSvc = await import("@/lib/projects/service");
    setSvc = await import("@/lib/prompts/set-service");
    promptSvc = await import("@/lib/prompts/prompt-service");
    runSvc = await import("@/lib/runs/service");
    execute = await import("@/lib/runs/execute");
    jobs = await import("@/db/jobs");
    companySvc = await import("@/lib/companies/service");
    claims = await import("@/lib/claims/service");
    parsing = await import("@/lib/parsing/service");
    scoring = await import("@/lib/scoring/compute");
    mock = await import("@/lib/ai/mock");
    await sql.unsafe("drop schema public cascade; create schema public;");
    execSync(`npx tsx scripts/migrate.ts up --db "${TEST_URL}"`, {
      cwd: ROOT,
      stdio: "pipe",
    });
    await seedTestActors(sql);
  });

  beforeEach(async () => {
    await sql.unsafe(
      `truncate audit_log, jobs, claims, tasks, evidence, intervention_runs,
       interventions, reports, brand_candidates, competitors, scores, sources,
       response_parses, mentions, companies, responses, runs,
       prompt_set_versions, prompts, prompt_sets, projects cascade`
    );
    mock.resetMockProvider();
  });

  afterAll(async () => {
    await sql.end();
  });

  async function drainJobs(): Promise<void> {
    for (let i = 0; i < 200; i += 1) {
      const job = await jobs.claimNextJob("test-worker");
      if (!job) return;
      if (job.type === "execute_run") await execute.executeRun(job.payload.runId as string);
      else if (job.type === "parse_response")
        await parsing.parseResponse(job.payload.responseId as string);
      else if (job.type === "compute_scores")
        await scoring.computeScores(job.payload.runId as string);
      await jobs.completeJob(job.id);
    }
  }

  async function makeClientProject(
    name: string,
    companyName: string,
    aliases: string[] = []
  ): Promise<{ projectId: string; companyId: string }> {
    const company = await companySvc.upsertCompany(user, {
      name: companyName,
      aliases,
    });
    if (!company.ok) throw new Error(company.error.message);
    const project = await projectSvc.createProject(user, { name });
    if (!project.ok) throw new Error(project.error.message);
    const subject = await claims.setSubjectCompany(user, {
      projectId: project.data.id,
      companyId: company.data.id,
    });
    if (!subject.ok) throw new Error(subject.error.message);
    return { projectId: project.data.id, companyId: company.data.id };
  }

  async function runForProject(projectId: string, promptText: string): Promise<string> {
    const set = await setSvc.createPromptSet(user, { projectId, name: "Set" });
    if (!set.ok) throw new Error(set.error.message);
    await promptSvc.addPrompt(user, {
      setId: set.data.id,
      text: promptText,
      category: "recommendation",
    });
    await setSvc.freezePromptSet(user, { id: set.data.id });
    const [version] = await sql`
      select id from prompt_set_versions where prompt_set_id = ${set.data.id}
    `;
    const started = await runSvc.startRun(user, {
      projectId,
      promptSetVersionId: version?.id as string,
      providers: [{ provider: "mock", model: "mock-model", repetitions: 1 }],
      budgetUsd: 5,
      label: `${projectId.slice(0, 8)} run`,
    });
    if (!started.ok) throw new Error(started.error.message);
    await drainJobs();
    return started.data.id;
  }

  it("two clients, two subjects — measurements never cross-talk", async () => {
    // Mock canned text mentions "Acme" and "Parva"
    const clientA = await makeClientProject("Client A", "Parva", ["parva.com"]);
    const clientB = await makeClientProject("Client B", "Acme");

    const runA = await runForProject(clientA.projectId, "best tools?");
    const runB = await runForProject(clientB.projectId, "best tools?");

    // Client A's run never mentions Client B's subject, and vice versa
    const mentionsA = await sql`
      select distinct company_id from mentions m
      join responses r on r.id = m.response_id where r.run_id = ${runA}
    `;
    const mentionsB = await sql`
      select distinct company_id from mentions m
      join responses r on r.id = m.response_id where r.run_id = ${runB}
    `;
    expect(mentionsA.map((m) => m.companyId)).toEqual([clientA.companyId]);
    expect(mentionsB.map((m) => m.companyId)).toEqual([clientB.companyId]);

    const scoresA = await sql`
      select distinct company_id from scores where run_id = ${runA}
    `;
    expect(scoresA.map((s) => s.companyId)).toEqual([clientA.companyId]);
  });

  it("parse refuses when a project has no subject and no legacy is_self", async () => {
    const project = await projectSvc.createProject(user, { name: "No Subject" });
    if (!project.ok) throw new Error(project.error.message);
    const set = await setSvc.createPromptSet(user, {
      projectId: project.data.id,
      name: "Set",
    });
    if (!set.ok) throw new Error(set.error.message);
    await promptSvc.addPrompt(user, {
      setId: set.data.id,
      text: "anything",
      category: "recommendation",
    });
    await setSvc.freezePromptSet(user, { id: set.data.id });
    const [version] = await sql`
      select id from prompt_set_versions where prompt_set_id = ${set.data.id}
    `;
    await runSvc.startRun(user, {
      projectId: project.data.id,
      promptSetVersionId: version?.id as string,
      providers: [{ provider: "mock", model: "mock-model", repetitions: 1 }],
      budgetUsd: 5,
      label: "no subject run",
    });
    const job = await jobs.claimNextJob("test-worker");
    await execute.executeRun(job!.payload.runId as string);
    const parseJob = await jobs.claimNextJob("test-worker");
    await expect(
      parsing.parseResponse(parseJob!.payload.responseId as string)
    ).rejects.toThrow(/subject company/);
  });

  it("legacy is_self still works as the fallback subject", async () => {
    await companySvc.upsertCompany(user, { name: "Parva", isSelf: true });
    const project = await projectSvc.createProject(user, { name: "Legacy" });
    if (!project.ok) throw new Error(project.error.message);
    const runId = await runForProject(project.data.id, "best tools?");
    const [count] = await sql`
      select count(*)::int as n from scores where run_id = ${runId}
    `;
    expect(count?.n).toBeGreaterThan(0);
  });

  it("claims: evidence required, approve supersedes, only proposed rejectable", async () => {
    const { projectId } = await makeClientProject("Claims Co", "Parva");

    const noEvidence = await claims.proposeClaim(user, {
      projectId,
      key: "category_positioning",
      canonicalText: "Link-in-bio for realtors",
      evidence: [],
    });
    expect(noEvidence.ok).toBe(false);

    const v1 = await claims.proposeClaim(user, {
      projectId,
      key: "Category Positioning", // normalizes to category_positioning
      canonicalText: "Parva is a link-in-bio tool built for real estate agents.",
      asOf: "2026-07-27",
      evidence: [{ url: "https://parva.com", note: "Homepage positioning" }],
    });
    expect(v1.ok).toBe(true);
    if (!v1.ok) return;
    expect(v1.data.key).toBe("category_positioning");

    const approved1 = await claims.approveClaim(user, { claimId: v1.data.id });
    expect(approved1.ok).toBe(true);
    if (approved1.ok) expect(approved1.data.supersededId).toBeNull();

    // Second version of the same fact supersedes on approval
    const v2 = await claims.proposeClaim(user, {
      projectId,
      key: "category_positioning",
      canonicalText: "Parva is the link-in-bio platform for real estate agents.",
      evidence: [{ url: "https://parva.com/about", note: "Updated wording" }],
    });
    if (!v2.ok) throw new Error(v2.error.message);
    const approved2 = await claims.approveClaim(user, { claimId: v2.data.id });
    expect(approved2.ok).toBe(true);
    if (approved2.ok) expect(approved2.data.supersededId).toBe(v1.data.id);

    const all = await claims.listClaims(projectId);
    const statuses = all
      .filter((c) => c.key === "category_positioning")
      .map((c) => c.status)
      .sort();
    expect(statuses).toEqual(["approved", "superseded"]);

    // Approved claims can't be rejected; double-approve fails
    const rejectApproved = await claims.rejectClaim(user, {
      claimId: v2.data.id,
    });
    expect(rejectApproved.ok).toBe(false);
    const doubleApprove = await claims.approveClaim(user, { claimId: v1.data.id });
    expect(doubleApprove.ok).toBe(false);

    const audits = await sql`
      select action from audit_log where entity = 'claim' order by at
    `;
    expect(audits.map((a) => a.action)).toEqual([
      "claim.propose",
      "claim.approve",
      "claim.propose",
      "claim.approve",
    ]);
  });
});
