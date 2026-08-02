/**
 * Spec 036 — head-to-head and citation profiles against real rows: seeded
 * mock run through parse + score, then both derived analyses.
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

describe.skipIf(!TEST_URL)("competitive depth (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let headToHead: typeof import("@/lib/competitors/head-to-head");
  let profiles: typeof import("@/lib/competitors/citation-profiles");
  let competitorSvc: typeof import("@/lib/competitors/service");
  let projectSvc: typeof import("@/lib/projects/service");
  let setSvc: typeof import("@/lib/prompts/set-service");
  let promptSvc: typeof import("@/lib/prompts/prompt-service");
  let runSvc: typeof import("@/lib/runs/service");
  let execute: typeof import("@/lib/runs/execute");
  let jobs: typeof import("@/db/jobs");
  let companySvc: typeof import("@/lib/companies/service");
  let parsing: typeof import("@/lib/parsing/service");
  let scoring: typeof import("@/lib/scoring/compute");
  let mock: typeof import("@/lib/ai/mock");

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    headToHead = await import("@/lib/competitors/head-to-head");
    profiles = await import("@/lib/competitors/citation-profiles");
    competitorSvc = await import("@/lib/competitors/service");
    projectSvc = await import("@/lib/projects/service");
    setSvc = await import("@/lib/prompts/set-service");
    promptSvc = await import("@/lib/prompts/prompt-service");
    runSvc = await import("@/lib/runs/service");
    execute = await import("@/lib/runs/execute");
    jobs = await import("@/db/jobs");
    companySvc = await import("@/lib/companies/service");
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
      `truncate audit_log, jobs, competitors, scores, sources, response_citations,
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
      if (job.type === "execute_run")
        await execute.executeRun(job.payload.runId as string);
      else if (job.type === "parse_response")
        await parsing.parseResponse(job.payload.responseId as string);
      else if (job.type === "compute_scores")
        await scoring.computeScores(job.payload.runId as string);
      await jobs.completeJob(job.id);
    }
  }

  async function seedScoredRun(): Promise<{
    projectId: string;
    runId: string;
    selfId: string;
    rivalId: string;
  }> {
    const self = await companySvc.upsertCompany(user, { name: "Lumina", isSelf: true });
    const rival = await companySvc.upsertCompany(user, { name: "Rival Co" });
    if (!self.ok || !rival.ok) throw new Error("company seed failed");
    const project = await projectSvc.createProject(user, { name: "Depth Test" });
    if (!project.ok) throw new Error(project.error.message);
    await competitorSvc.addCompetitor(user, {
      projectId: project.data.id,
      companyId: rival.data.id,
      tier: "primary",
    });
    const set = await setSvc.createPromptSet(user, {
      projectId: project.data.id,
      name: "Set",
    });
    if (!set.ok) throw new Error(set.error.message);
    await promptSvc.addPrompt(user, {
      setId: set.data.id,
      text: "What are the best tools?",
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
      label: "depth run",
    });
    if (!started.ok) throw new Error(started.error.message);
    await drainJobs();
    return {
      projectId: project.data.id,
      runId: started.data.id,
      selfId: self.data.id,
      rivalId: rival.data.id,
    };
  }

  it("derives head-to-head from real mentions and matches a hand recount", async () => {
    const { projectId, runId, selfId, rivalId } = await seedScoredRun();
    const result = await headToHead.headToHeadForProject(projectId);
    expect(result.runId).toBe(runId);
    expect(result.selfCompanyId).toBe(selfId);
    const [row] = result.rows;
    expect(row?.companyId).toBe(rivalId);

    // Recount independently from the database.
    const mentions = await sql`
      select m.response_id, m.company_id, m.mentioned, m.list_position
      from mentions m join responses r on r.id = m.response_id
      where r.run_id = ${runId}
        and not exists (select 1 from mentions n
          where n.response_id = m.response_id and n.company_id = m.company_id
            and n.revision > m.revision)
    `;
    const responses = await sql`
      select id from responses where run_id = ${runId} and error is null
    `;
    let expectedContested = 0;
    for (const response of responses) {
      const here = mentions.filter((m) => m.responseId === response.id);
      const s = here.find((m) => m.companyId === selfId);
      const c = here.find((m) => m.companyId === rivalId);
      if (Boolean(s?.mentioned) || Boolean(c?.mentioned)) expectedContested += 1;
    }
    expect(row?.contested).toBe(expectedContested);
    expect((row?.selfWins ?? 0) + (row?.competitorWins ?? 0) + (row?.ties ?? 0)).toBe(
      expectedContested
    );
  });

  it("citation profiles read the ledger and label from the project registry", async () => {
    const { projectId } = await seedScoredRun();
    const result = await profiles.citationProfilesForProject(projectId);
    expect(result.version).toBe("citation-profile-v1");
    expect(result.note).toContain("not proof");
    expect(result.profiles.length).toBeGreaterThan(0);
    const self = result.profiles.find((p) => p.isSelf);
    expect(self).toBeDefined();
    expect(self?.sourceGap).toEqual([]);
    // Every profile domain must exist in the run's citation ledger.
    const ledger = await sql`select distinct domain from response_citations`;
    const ledgerDomains = new Set(ledger.map((r) => r.domain as string));
    for (const profile of result.profiles) {
      for (const d of profile.domains) {
        expect(ledgerDomains.has(d.domain)).toBe(true);
      }
    }
  });

  it("no scored run yields empty analyses, not errors", async () => {
    const project = await projectSvc.createProject(user, { name: "Empty" });
    if (!project.ok) throw new Error(project.error.message);
    const h2h = await headToHead.headToHeadForProject(project.data.id);
    expect(h2h.runId).toBeNull();
    expect(h2h.rows).toEqual([]);
    const prof = await profiles.citationProfilesForProject(project.data.id);
    expect(prof.runId).toBeNull();
    expect(prof.profiles).toEqual([]);
  });

  it("archived competitors stay in the analysis, flagged", async () => {
    const { projectId, rivalId } = await seedScoredRun();
    const [competitor] = await sql`
      select id from competitors where project_id = ${projectId} and company_id = ${rivalId}
    `;
    const archived = await competitorSvc.archiveCompetitor(user, {
      competitorId: competitor?.id as string,
    });
    expect(archived.ok).toBe(true);
    const result = await headToHead.headToHeadForProject(projectId);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.archived).toBe(true);
  });
});
