/**
 * Integration tests for spec 086 — market-level citation intelligence.
 * The invariant under test: every number in the market source graph
 * reconciles exactly to stored response_citations rows produced by the REAL
 * pipeline (mock provider, real parse), and thin evidence reports itself as
 * insufficient instead of ranking confidently.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { seedTestActors } from "../helpers/actors";
import { unwrap } from "../helpers/result";

const TEST_URL = process.env.TEST_DATABASE_URL;
const ROOT = join(__dirname, "..", "..");

const operator: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000401",
  email: "op@test.local",
  name: "Operator",
  role: "operator",
};
const admin: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "admin@test.local",
  name: "Admin",
  role: "admin",
};

describe.skipIf(!TEST_URL)("market citation intelligence (integration)", () => {
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
  let exclusivity: typeof import("@/lib/exclusivity/service");
  let svc: typeof import("@/lib/prospects/service");
  let market: typeof import("@/lib/citations/market");
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
    exclusivity = await import("@/lib/exclusivity/service");
    svc = await import("@/lib/prospects/service");
    market = await import("@/lib/citations/market");
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
      `truncate audit_log, jobs, prospect_activities, prospect_stage_history,
       prospect_findings, prospect_benchmarks, prospect_authority_signals,
       prospects, market_launches,
       exclusivity_checks, exclusivity_scopes, exclusivity_agreements, markets,
       claims, competitors, scores, sources, response_parses, mentions,
       response_citations, brand_candidates, companies, responses, runs,
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

  /** Real pipeline: mock answers cite lumina.io (owned) and example.com
   * (third-party); the prospect is linked to the subject company so
   * presence semantics are exercised. */
  async function seed(repetitions: number): Promise<{ launchId: string; projectId: string }> {
    const subject = unwrap(
      await companySvc.upsertCompany(operator, { name: "Lumina", domain: "lumina.io" })
    );
    const project = unwrap(
      await projectSvc.createProject(operator, { name: "Prospect benchmark: Lumina" })
    );
    await sql`update projects set kind = 'prospect' where id = ${project.id}`;
    unwrap(
      await claims.setSubjectCompany(operator, { projectId: project.id, companyId: subject.id })
    );
    const set = unwrap(
      await setSvc.createPromptSet(operator, { projectId: project.id, name: "Set" })
    );
    for (const text of [
      "best team for a jersey city condo? MOCK_CITE_OWNED",
      "who do independent roundups suggest? MOCK_CITE_OTHER",
    ]) {
      unwrap(
        await promptSvc.addPrompt(operator, { setId: set.id, text, category: "recommendation" })
      );
    }
    unwrap(await setSvc.freezePromptSet(operator, { id: set.id }));
    const [version] = await sql`
      select id from prompt_set_versions where prompt_set_id = ${set.id}
    `;
    unwrap(
      await runSvc.startRun(operator, {
        projectId: project.id,
        promptSetVersionId: version?.id as string,
        providers: [{ provider: "mock", model: "mock-model", repetitions }],
        budgetUsd: 5,
        label: "benchmark",
      })
    );
    await drainJobs();

    const mkt = unwrap(
      await exclusivity.createMarket(admin, { name: "Jersey City", kind: "city", aliases: [] })
    );
    const launch = unwrap(
      await svc.createLaunch(operator, {
        name: "Jersey City luxury residential",
        marketId: mkt.marketId,
        priceSegment: "luxury",
        serviceCategory: "residential brokerage",
      })
    );
    const prospect = unwrap(
      await svc.createProspect(operator, {
        launchId: launch.launchId,
        businessName: "Lumina",
        prospectType: "team",
        companyId: subject.id,
      })
    );
    // Mirrors createBenchmarkProject's linkage (service.ts): the prospect's
    // benchmark project is where its runs live.
    await sql`
      update prospects set benchmark_project_id = ${project.id}
      where id = ${prospect.prospectId}
    `;
    return { launchId: launch.launchId, projectId: project.id };
  }

  it("aggregates reconcile exactly to stored response_citations rows", async () => {
    const { launchId, projectId } = await seed(5);
    const graph = await market.marketSourceGraph(launchId);

    const [ledger] = await sql`
      select count(*)::int as citations from response_citations rc
      join responses r on r.id = rc.response_id
      where r.run_id in (select id from runs where project_id = ${projectId})
        and r.error is null
    `;
    expect(graph.totals.citations).toBe(ledger?.citations as number);
    expect(graph.totals.citations).toBeGreaterThanOrEqual(10);
    expect(
      graph.domains.reduce((sum, d) => sum + d.citations, 0)
    ).toBe(graph.totals.citations);
    expect(graph.sufficient).toBe(true);

    const domains = graph.domains.map((d) => d.domain).sort();
    expect(domains).toContain("lumina.io");
    expect(domains).toContain("example.com");
  });

  it("prospect presence: own-domain citations counted, co-mentions traced, absence never invented", async () => {
    const { launchId } = await seed(5);
    const graph = await market.marketSourceGraph(launchId);

    const lumina = graph.prospects.find((p) => p.businessName === "Lumina")!;
    expect(lumina).toBeDefined();
    // MOCK_CITE_OWNED answers cite lumina.io 5 times.
    expect(lumina.ownDomainCitations).toBe(5);
    // MOCK_CITE_OTHER answers mention Lumina while citing example.com.
    expect(lumina.presentInDomains).toContain("example.com");

    const example = graph.domains.find((d) => d.domain === "example.com")!;
    expect(example.prospectOwnerIds).toEqual([]);
    const luminaRow = example.companiesInCitingAnswers.find((c) => c.name === "Lumina");
    expect(luminaRow?.isLaunchProspect).toBe(true);
  });

  it("thin evidence reports insufficient instead of a confident ranking", async () => {
    const { launchId } = await seed(1);
    const graph = await market.marketSourceGraph(launchId);
    expect(graph.totals.citations).toBeGreaterThan(0);
    expect(graph.totals.citations).toBeLessThan(market.MIN_MARKET_CITATIONS);
    expect(graph.sufficient).toBe(false);
  });

  it("a launch with no benchmarked prospects yields the empty graph, not fabricated zeros", async () => {
    const mkt = unwrap(
      await exclusivity.createMarket(admin, { name: "Hoboken", kind: "city", aliases: [] })
    );
    const launch = unwrap(
      await svc.createLaunch(operator, {
        name: "Hoboken residential",
        marketId: mkt.marketId,
        priceSegment: "luxury",
        serviceCategory: "residential brokerage",
      })
    );
    const graph = await market.marketSourceGraph(launch.launchId);
    expect(graph.sufficient).toBe(false);
    expect(graph.domains).toEqual([]);
    expect(graph.totals).toEqual({ responses: 0, citations: 0, runs: 0, projects: 0 });
  });
});
