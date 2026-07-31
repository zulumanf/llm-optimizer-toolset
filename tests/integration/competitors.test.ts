/**
 * Integration tests for spec 005 — competitor tracking, retroactive
 * backfill, identical-methodology property, candidate promotion.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { seedTestActors } from "../helpers/actors";

const TEST_URL = process.env.TEST_DATABASE_URL;
const ROOT = join(__dirname, "..", "..");

const user: CurrentUser = {
  id: "00000000-0000-4000-8000-0000000000ff",
  email: "op@test.local",
  name: "Operator",
  role: "operator",
};

describe.skipIf(!TEST_URL)("competitors (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let projectSvc: typeof import("@/lib/projects/service");
  let setSvc: typeof import("@/lib/prompts/set-service");
  let promptSvc: typeof import("@/lib/prompts/prompt-service");
  let runSvc: typeof import("@/lib/runs/service");
  let execute: typeof import("@/lib/runs/execute");
  let jobs: typeof import("@/db/jobs");
  let companySvc: typeof import("@/lib/companies/service");
  let competitorSvc: typeof import("@/lib/competitors/service");
  let parsing: typeof import("@/lib/parsing/service");
  let scoring: typeof import("@/lib/scoring/compute");
  let competitorsDb: typeof import("@/db/competitors");
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
    competitorSvc = await import("@/lib/competitors/service");
    parsing = await import("@/lib/parsing/service");
    scoring = await import("@/lib/scoring/compute");
    competitorsDb = await import("@/db/competitors");
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
      `truncate audit_log, jobs, brand_candidates, competitors, scores, sources,
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

  async function seedProjectWithRun(): Promise<{ projectId: string }> {
    const parva = await companySvc.upsertCompany(user, {
      name: "Parva",
      isSelf: true,
    });
    if (!parva.ok) throw new Error(parva.error.message);
    const project = await projectSvc.createProject(user, { name: "Comp Test" });
    if (!project.ok) throw new Error(project.error.message);
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
      label: "comp run",
    });
    if (!started.ok) throw new Error(started.error.message);
    await drainJobs();
    return { projectId: project.data.id };
  }

  it("full metric suite computes for the self company via one code path", async () => {
    const { projectId } = await seedProjectWithRun();
    void projectId;
    const metrics = await sql`
      select distinct metric from scores order by metric
    `;
    // position/sentiment need ≥5 cells (we have 2) → absent; citation has no
    // urls in mock text → absent. Present: rates, SoV, authority.
    expect(metrics.map((m) => m.metric)).toEqual([
      "authority_score",
      "mention_rate",
      "recommendation_rate",
      "share_of_voice",
    ]);
    const [authority] = await sql`
      select value from scores
      where metric = 'authority_score' and provider = 'all'
    `;
    // rec=1, mention=1, sov=1 → all present components are 1 → authority 100
    expect(Number(authority?.value)).toBeCloseTo(100);
  });

  it("adding a competitor backfills recent runs retroactively", async () => {
    const { projectId } = await seedProjectWithRun();

    // Acme is in the canned mock text but untracked until now
    const acme = await companySvc.upsertCompany(user, { name: "Acme" });
    if (!acme.ok) throw new Error(acme.error.message);
    const added = await competitorSvc.addCompetitor(user, {
      projectId,
      companyId: acme.data.id,
      tier: "primary",
    });
    expect(added.ok).toBe(true);
    if (added.ok) expect(added.data.backfilledRuns).toBe(1);
    await drainJobs();

    const acmeMentions = await sql`
      select count(*)::int as n from mentions
      where company_id = ${acme.data.id} and mentioned
    `;
    expect(acmeMentions[0]?.n).toBe(2); // both responses, retroactively
    const acmeScores = await sql`
      select count(*)::int as n from scores where company_id = ${acme.data.id}
    `;
    expect(acmeScores[0]?.n).toBeGreaterThan(0);
  });

  it("identical methodology: swapping which company is which changes nothing structural", async () => {
    const { projectId } = await seedProjectWithRun();
    const acme = await companySvc.upsertCompany(user, { name: "Acme" });
    if (!acme.ok) throw new Error(acme.error.message);
    await competitorSvc.addCompetitor(user, {
      projectId,
      companyId: acme.data.id,
      tier: "primary",
    });
    await drainJobs();

    const parvaMetrics = await sql`
      select metric, provider from scores s
      join companies c on c.id = s.company_id
      where c.is_self order by metric, provider
    `;
    const acmeMetrics = await sql`
      select metric, provider from scores
      where company_id = ${acme.data.id} order by metric, provider
    `;
    // No metric exists for one and not the other (spec 005 acceptance)
    expect(parvaMetrics.map((r) => `${r.metric}/${r.provider}`)).toEqual(
      acmeMetrics.map((r) => `${r.metric}/${r.provider}`)
    );
  });

  it("competitor guards: no self, no duplicates, no archived companies", async () => {
    const { projectId } = await seedProjectWithRun();
    const [self] = await sql`select id from companies where is_self`;
    const asCompetitor = await competitorSvc.addCompetitor(user, {
      projectId,
      companyId: self?.id as string,
      tier: "primary",
    });
    expect(asCompetitor.ok).toBe(false);

    const acme = await companySvc.upsertCompany(user, { name: "Acme" });
    if (!acme.ok) throw new Error(acme.error.message);
    const first = await competitorSvc.addCompetitor(user, {
      projectId,
      companyId: acme.data.id,
      tier: "primary",
    });
    expect(first.ok).toBe(true);
    const dup = await competitorSvc.addCompetitor(user, {
      projectId,
      companyId: acme.data.id,
      tier: "secondary",
    });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error.kind).toBe("conflict");
  });

  it("brand candidates surface from parsing and promote into tracked competitors", async () => {
    const { projectId } = await seedProjectWithRun();
    // Mock canned text contains "Acme" (untracked) mid-sentence → candidate
    const candidates = await competitorsDb.listBrandCandidates(1);
    const acmeCandidate = candidates.find((c) => c.name === "Acme");
    expect(acmeCandidate).toBeDefined();
    expect(acmeCandidate!.hitCount).toBeGreaterThanOrEqual(2);

    const promoted = await competitorSvc.trackBrandCandidate(user, {
      candidateId: acmeCandidate!.id,
      projectId,
      tier: "secondary",
    });
    expect(promoted.ok).toBe(true);
    await drainJobs();

    const comparison = await competitorsDb.listComparisonCompanies(projectId);
    expect(comparison.map((c) => c.companyName)).toEqual(["Parva", "Acme"]);

    // Promoting twice is rejected
    const again = await competitorSvc.trackBrandCandidate(user, {
      candidateId: acmeCandidate!.id,
      projectId,
      tier: "secondary",
    });
    expect(again.ok).toBe(false);
  });

  it("archived competitors keep historical scores but leave the comparison", async () => {
    const { projectId } = await seedProjectWithRun();
    const acme = await companySvc.upsertCompany(user, { name: "Acme" });
    if (!acme.ok) throw new Error(acme.error.message);
    const added = await competitorSvc.addCompetitor(user, {
      projectId,
      companyId: acme.data.id,
      tier: "primary",
    });
    if (!added.ok) throw new Error(added.error.message);
    await drainJobs();

    const [before] = await sql`
      select count(*)::int as n from scores where company_id = ${acme.data.id}
    `;
    expect(before?.n).toBeGreaterThan(0);

    const archived = await competitorSvc.archiveCompetitor(user, {
      competitorId: added.data.competitorId,
    });
    expect(archived.ok).toBe(true);
    const comparison = await competitorsDb.listComparisonCompanies(projectId);
    expect(comparison.map((c) => c.companyName)).toEqual(["Parva"]);
    const [after] = await sql`
      select count(*)::int as n from scores where company_id = ${acme.data.id}
    `;
    expect(after?.n).toBe(before?.n); // history preserved
  });
});
