/**
 * Integration tests for spec 032 Phase 2.1 — prospect-owned benchmark
 * projects (`projects.kind='prospect'`).
 *
 * The load-bearing case: creating a prospect whose subject was already an
 * ordinary measured company must NOT change any client's measured set or
 * share-of-voice denominator. The old exclusion rule ("not another
 * project's subject") would have silently dropped the company from every
 * client run the moment the prospect project existed.
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
const clientViewer: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000002",
  email: "client@test.local",
  name: "Client",
  role: "client_viewer",
};

describe.skipIf(!TEST_URL)("prospect benchmark projects (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let dbProjects: typeof import("@/db/projects");
  let dbCompanies: typeof import("@/db/companies");
  let dbControlTower: typeof import("@/db/control-tower");
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
  let mock: typeof import("@/lib/ai/mock");

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    dbProjects = await import("@/db/projects");
    dbCompanies = await import("@/db/companies");
    dbControlTower = await import("@/db/control-tower");
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
    mock = await import("@/lib/ai/mock");
    await sql.unsafe("drop schema public cascade; create schema public;");
    execSync(`npx tsx scripts/migrate.ts up --db "${TEST_URL}"`, {
      cwd: ROOT,
      stdio: "pipe",
    });
    await seedTestActors(sql);
    await sql`update users set role = 'client_viewer' where id = ${clientViewer.id}`;
  });

  beforeEach(async () => {
    await sql.unsafe(
      `truncate audit_log, jobs,
       prospect_activities, prospect_stage_history, screen_recording_plans,
       outreach_drafts, prospect_audit_views, prospect_audits,
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


  async function runBenchmark(projectId: string, label: string): Promise<string> {
    const set = unwrap(
      await setSvc.createPromptSet(operator, { projectId, name: `Set ${label}` })
    );
    for (const text of ["best luxury team in manhattan?", "who should sell my loft?"]) {
      unwrap(
        await promptSvc.addPrompt(operator, { setId: set.id, text, category: "recommendation" })
      );
    }
    unwrap(await setSvc.freezePromptSet(operator, { id: set.id }));
    const [version] = await sql`
      select id from prompt_set_versions where prompt_set_id = ${set.id}
    `;
    const run = unwrap(
      await runSvc.startRun(operator, {
        projectId,
        promptSetVersionId: version?.id as string,
        providers: [{ provider: "mock", model: "mock-model", repetitions: 3 }],
        budgetUsd: 5,
        label,
      })
    );
    await drainJobs();
    return run.id;
  }

  async function seedClient(): Promise<{ projectId: string; subjectId: string }> {
    const subject = unwrap(await companySvc.upsertCompany(operator, { name: "Lumina" }));
    unwrap(await companySvc.upsertCompany(operator, { name: "Acme" }));
    unwrap(await companySvc.upsertCompany(operator, { name: "Rivera Team" }));
    const project = unwrap(await projectSvc.createProject(operator, { name: "Client A" }));
    unwrap(
      await claims.setSubjectCompany(operator, { projectId: project.id, companyId: subject.id })
    );
    return { projectId: project.id, subjectId: subject.id };
  }

  async function seedLaunchAndProspect(): Promise<{ launchId: string; prospectId: string }> {
    const market = unwrap(
      await exclusivity.createMarket(admin, { name: "Manhattan", kind: "borough", aliases: [] })
    );
    const launch = unwrap(
      await svc.createLaunch(operator, {
        name: "Manhattan luxury residential",
        marketId: market.marketId,
      })
    );
    const prospect = unwrap(
      await svc.createProspect(operator, {
        launchId: launch.launchId,
        businessName: "Rivera Team",
        prospectType: "team",
      })
    );
    return { launchId: launch.launchId, prospectId: prospect.prospectId };
  }

  it("creating a prospect project does not change a client's measured set or scores", async () => {
    const { projectId: clientId, subjectId } = await seedClient();
    const run1 = await runBenchmark(clientId, "before prospect");

    const before = (await dbCompanies.listCompaniesForProject(clientId)).map((c) => c.name);
    expect(before).toContain("Rivera Team");
    const scoresBefore = await sql`
      select company_id, metric, value, sample_size from scores
      where run_id = ${run1} and provider = 'all' order by company_id, metric
    `;
    expect(scoresBefore.length).toBeGreaterThan(0);

    // The prospect project claims Rivera Team as its subject
    const { prospectId } = await seedLaunchAndProspect();
    const created = unwrap(await svc.createBenchmarkProject(operator, { prospectId }));
    const [kindRow] = await sql`select kind from projects where id = ${created.projectId}`;
    expect(kindRow?.kind).toBe("prospect");

    // Client's measured set is unchanged — Rivera Team is still in it
    const after = (await dbCompanies.listCompaniesForProject(clientId)).map((c) => c.name);
    expect(after).toEqual(before);

    // A fresh identical client run scores identically (same mock answers,
    // same company set, same denominators)
    const run2 = await runBenchmark(clientId, "after prospect");
    const scoresAfter = await sql`
      select company_id, metric, value, sample_size from scores
      where run_id = ${run2} and provider = 'all' order by company_id, metric
    `;
    expect(scoresAfter.map((r) => [r.companyId, r.metric, r.value, r.sampleSize])).toEqual(
      scoresBefore.map((r) => [r.companyId, r.metric, r.value, r.sampleSize])
    );

    // …while an actual CLIENT subject is still excluded from the other
    // client's set (spec 008 no-cross-talk between clients is intact)
    const clientB = unwrap(await projectSvc.createProject(operator, { name: "Client B" }));
    const acme = await sql`select id from companies where name = 'Acme'`;
    unwrap(
      await claims.setSubjectCompany(operator, {
        projectId: clientB.id,
        companyId: acme[0]?.id as string,
      })
    );
    const afterClientB = (await dbCompanies.listCompaniesForProject(clientId)).map(
      (c) => c.name
    );
    expect(afterClientB).not.toContain("Acme");
    expect(afterClientB).toContain("Rivera Team");
    expect(subjectId).toBeTruthy();
  });

  it("creates the benchmark project reusing the existing company and pre-tracking launch rivals", async () => {
    await seedClient(); // registers Rivera Team as an existing company
    const { launchId, prospectId } = await seedLaunchAndProspect();
    // A second prospect in the launch, with its own company
    const gables = unwrap(await companySvc.upsertCompany(operator, { name: "Gables Group" }));
    unwrap(
      await svc.createProspect(operator, {
        launchId,
        businessName: "Gables Group",
        companyId: gables.id,
      })
    );

    const created = unwrap(await svc.createBenchmarkProject(operator, { prospectId }));

    // Reused the existing "Rivera Team" company rather than creating a duplicate
    const riveras = await sql`
      select id from companies where lower(name) = 'rivera team' and archived_at is null
    `;
    expect(riveras.length).toBe(1);
    expect(created.companyId).toBe(riveras[0]?.id);

    // Subject set, rival pre-tracked
    const [project] = await sql`
      select subject_company_id, kind from projects where id = ${created.projectId}
    `;
    expect(project?.subjectCompanyId).toBe(created.companyId);
    expect(created.competitorsTracked).toBe(1);
    const rivals = await sql`
      select company_id from competitors where project_id = ${created.projectId}
    `;
    expect(rivals.map((r) => r.companyId)).toEqual([gables.id]);

    // Second creation refused
    const again = await svc.createBenchmarkProject(operator, { prospectId });
    expect(again.ok).toBe(false);
  });

  it("keeps prospect projects out of client-facing and portfolio surfaces", async () => {
    await seedClient();
    const { prospectId } = await seedLaunchAndProspect();
    const created = unwrap(await svc.createBenchmarkProject(operator, { prospectId }));

    const active = await dbProjects.listActiveProjects(null);
    expect(active.map((p) => p.id)).not.toContain(created.projectId);
    const portfolio = await dbProjects.listPortfolio({ includeArchived: true });
    expect(portfolio.map((p) => p.id)).not.toContain(created.projectId);
    const listed = await dbProjects.listProjects({ includeArchived: true });
    expect(listed.map((p) => p.id)).not.toContain(created.projectId);

    const metrics = await dbControlTower.portfolioMetrics();
    expect(Number(metrics.activeClients)).toBe(1); // Client A only
  });

  it("runs a fresh benchmark inside the prospect project end to end", async () => {
    await seedClient();
    const { prospectId } = await seedLaunchAndProspect();
    const created = unwrap(await svc.createBenchmarkProject(operator, { prospectId }));

    // The full measurement pipeline works on a kind='prospect' project
    const runId = await runBenchmark(created.projectId, "prospect fresh benchmark");
    const [scored] = await sql`
      select count(*)::int as n from scores
      where run_id = ${runId} and company_id = ${created.companyId}
    `;
    expect(scored?.n).toBeGreaterThan(0);

    // …and feeds straight back into the slice: link → metrics
    const { benchmarkId } = unwrap(await svc.linkBenchmark(operator, { prospectId, runId }));
    const view = await svc.benchmarkMetrics(benchmarkId);
    expect(view.prospect).not.toBeNull();
    expect(view.prospect?.sampleSize).toBeGreaterThanOrEqual(6);
    // Rivera Team never appears in mock answers — honest zero, not absence
    expect(view.prospect?.mentionRate).toBe(0);
  });

  it("denies client roles", async () => {
    await seedClient();
    const { prospectId } = await seedLaunchAndProspect();
    const denied = await svc.createBenchmarkProject(clientViewer, { prospectId });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.kind).toBe("forbidden");
  });

  it("refuses an ambiguous company resolution instead of minting a duplicate (spec 050)", async () => {
    // "Rivera Team" exists in the registry (the client's subject). A prospect
    // named "Rivera Group" is a near-collision the resolver flags `possible`;
    // the old exact-name-or-create path would have silently created a second
    // company. The bootstrap now refuses and names the candidate.
    await seedClient();
    const { launchId } = await seedLaunchAndProspect();
    const near = unwrap(
      await svc.createProspect(operator, {
        launchId,
        businessName: "Rivera Group",
        prospectType: "team",
      })
    );
    const refused = await svc.createBenchmarkProject(operator, {
      prospectId: near.prospectId,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.kind).toBe("conflict");
      expect(refused.error.message).toContain("Rivera Team");
    }
    // No duplicate company was minted
    const [dupes] = await sql`
      select count(*)::int as n from companies
      where lower(name) = 'rivera group' and archived_at is null
    `;
    expect(dupes?.n).toBe(0);
  });

  it("creates a new company only when resolution is genuinely `none`", async () => {
    await seedClient();
    const { launchId } = await seedLaunchAndProspect();
    const fresh = unwrap(
      await svc.createProspect(operator, {
        launchId,
        businessName: "Harborline Property Advisors",
        prospectType: "team",
      })
    );
    const created = unwrap(
      await svc.createBenchmarkProject(operator, { prospectId: fresh.prospectId })
    );
    const [row] = await sql`select name from companies where id = ${created.companyId}`;
    expect(row?.name).toBe("Harborline Property Advisors");
  });
});
