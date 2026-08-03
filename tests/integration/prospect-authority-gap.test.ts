/**
 * Integration tests for spec 038 — authority profile, valuable visibility and
 * the gap over a real scored mock run, through the real read paths, plus the
 * audit snapshot addition. Expected numbers are derived by hand from the
 * rubric in lib/prospects/authority.ts and the credit weights in
 * lib/scoring/valuable.ts.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { seedTestActors } from "../helpers/actors";

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

describe.skipIf(!TEST_URL)("prospect authority & visibility gap (integration)", () => {
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
  let gap: typeof import("@/lib/prospects/gap");
  let benchmarkLib: typeof import("@/lib/prospects/benchmark");
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
    gap = await import("@/lib/prospects/gap");
    benchmarkLib = await import("@/lib/prospects/benchmark");
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
      `truncate audit_log, jobs,
       prospect_activities, prospect_stage_history, screen_recording_plans,
       outreach_drafts, prospect_contacts, prospect_audit_views, prospect_audits,
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

  const unwrap = <T,>(r: { ok: true; data: T } | { ok: false; error: { message: string } }): T => {
    if (!r.ok) throw new Error(r.error.message);
    return r.data;
  };

  /**
   * Scored run: 2 organic recommendation prompts + 1 branded prompt naming
   * the prospect, ×3 reps. The mock's default answer recommends Acme and the
   * subject Lumina; "Rivera Team" never appears.
   */
  async function seedAll(): Promise<{
    runId: string;
    prospectId: string;
    prospectCompanyId: string;
  }> {
    const subject = unwrap(await companySvc.upsertCompany(operator, { name: "Lumina" }));
    unwrap(await companySvc.upsertCompany(operator, { name: "Acme" }));
    const rivera = unwrap(await companySvc.upsertCompany(operator, { name: "Rivera Team" }));
    const project = unwrap(await projectSvc.createProject(operator, { name: "Client A" }));
    unwrap(
      await claims.setSubjectCompany(operator, { projectId: project.id, companyId: subject.id })
    );
    const set = unwrap(
      await setSvc.createPromptSet(operator, { projectId: project.id, name: "Set" })
    );
    for (const p of [
      { text: "best luxury team in manhattan?", category: "recommendation" as const },
      { text: "which team should sell my tribeca loft?", category: "recommendation" as const },
      { text: "is Rivera Team any good at luxury sales?", category: "branded" as const },
    ]) {
      unwrap(await promptSvc.addPrompt(operator, { setId: set.id, ...p }));
    }
    unwrap(await setSvc.freezePromptSet(operator, { id: set.id }));
    const [version] = await sql`
      select id from prompt_set_versions where prompt_set_id = ${set.id}
    `;
    const run = unwrap(
      await runSvc.startRun(operator, {
        projectId: project.id,
        promptSetVersionId: version?.id as string,
        providers: [{ provider: "mock", model: "mock-model", repetitions: 3 }],
        budgetUsd: 5,
        label: "gap benchmark run",
      })
    );
    await drainJobs();

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
        companyId: rivera.id,
        teamLeader: "Ana Rivera",
      })
    );
    unwrap(await svc.linkBenchmark(operator, { prospectId: prospect.prospectId, runId: run.id }));
    return { runId: run.id, prospectId: prospect.prospectId, prospectCompanyId: rivera.id };
  }

  it("valuable visibility: branded echo excluded, absent prospect scores 0, present rival scores > 0", async () => {
    const { runId, prospectCompanyId } = await seedAll();

    const rivera = await benchmarkLib.valuableVisibility(runId, prospectCompanyId);
    // 3 prompts × 3 reps = 9 valid responses; the branded prompt named the
    // prospect → its 3 cells are excluded, 6 organic remain.
    expect(rivera.organicResponses).toBe(6);
    expect(rivera.brandedExcluded).toBe(3);
    // Never mentioned → measured zero (a real measurement, not a data gap).
    expect(rivera.score).toBe(0);
    expect(rivera.weightedMentionRate).toBe(0);

    const [acme] = await sql`select id from companies where name = 'Acme'`;
    const acmeVisibility = await benchmarkLib.valuableVisibility(runId, acme?.id as string);
    // Acme is recommended in every mock answer and no prompt names it.
    expect(acmeVisibility.organicResponses).toBe(9);
    expect(acmeVisibility.brandedExcluded).toBe(0);
    expect(acmeVisibility.score).toBeGreaterThan(0);
    expect(acmeVisibility.weightedRecommendationRate).toBeGreaterThan(0.5);
  });

  it("authority profile + gap through the real read path, with global evidence excluded", async () => {
    const { prospectId } = await seedAll();

    unwrap(
      await svc.addAuthoritySignal(operator, {
        prospectId,
        kind: "ranking",
        label: "Ranked #2 Manhattan team by closed volume",
        sourceUrl: "https://example.com/ranking",
        provenance: "verified",
        scope: "local",
        retrievedAt: "2026-08-01",
      })
    );
    unwrap(
      await svc.addAuthoritySignal(operator, {
        prospectId,
        kind: "transaction_volume",
        label: "$310M Manhattan volume 2025",
        sourceUrl: "https://example.com/volume",
        provenance: "publicly_sourced",
      })
    );
    unwrap(
      await svc.addAuthoritySignal(operator, {
        prospectId,
        kind: "transaction_volume",
        label: "$2.1B nationwide brand volume",
        sourceUrl: "https://example.com/national",
        provenance: "verified",
        scope: "global",
      })
    );

    const view = await gap.authorityGapForProspect(prospectId);
    // ranking 15×1.0 + volume 12×0.85 = 25.2; global volume excluded.
    expect(view.authority.score).toBeCloseTo(25.2, 10);
    expect(view.authority.excluded.length).toBe(1);
    const excludedId = view.authority.excluded[0]!.signalId;
    expect(view.signals.find((s) => s.id === excludedId)?.label).toContain("nationwide");
    // confidence = 0.5×((1.0+0.85)/2) + 0.5×(2/5)
    expect(view.authority.confidence).toBeCloseTo(0.6625, 10);
    // Visibility measured at 0 for the absent prospect → gap = full authority.
    expect(view.visibility?.score).toBe(0);
    expect(view.gap).toBeCloseTo(25.2, 10);
    expect(view.benchmarkRunId).not.toBeNull();
  });

  it("published audit snapshot carries the gap with provenance-labeled evidence, token-readable", async () => {
    const { prospectId } = await seedAll();
    unwrap(
      await svc.addAuthoritySignal(operator, {
        prospectId,
        kind: "ranking",
        label: "Ranked #2 Manhattan team by closed volume",
        sourceUrl: "https://example.com/ranking",
        provenance: "verified",
      })
    );

    // Approve a primary finding so publishAudit has its evidence chain.
    const [benchmark] = await sql`
      select id from prospect_benchmarks where prospect_id = ${prospectId}
    `;
    unwrap(await svc.generateFindings(operator, { benchmarkId: benchmark?.id as string }));
    const [candidate] = await sql`
      select id from prospect_findings
      where prospect_id = ${prospectId} and status = 'candidate'
      order by rank_score desc limit 1
    `;
    unwrap(
      await svc.reviewFinding(operator, {
        findingId: candidate?.id as string,
        decision: "approved",
        makePrimary: true,
      })
    );

    const { accessToken } = unwrap(await svc.publishAudit(operator, { prospectId }));
    const snapshot = await svc.getAuditByToken(accessToken, { userAgent: "vitest" });
    expect(snapshot?.authorityGap).toBeDefined();
    expect(snapshot?.authorityGap?.authorityScore).toBe(15);
    expect(snapshot?.authorityGap?.visibilityScore).toBe(0);
    expect(snapshot?.authorityGap?.gap).toBe(15);
    expect(snapshot?.authorityGap?.authorityVersion).toBe("authority-v1");
    expect(snapshot?.authorityGap?.visibilityVersion).toBe("valuable-visibility-v1");
    expect(snapshot?.authorityGap?.signals).toEqual([
      {
        label: "Ranked #2 Manhattan team by closed volume",
        provenance: "verified",
        sourceUrl: "https://example.com/ranking",
      },
    ]);
    // The snapshot carries no internal signal ids.
    expect(JSON.stringify(snapshot?.authorityGap)).not.toContain("signalId");
    // The comparison shows visible rivals from the run — and NEVER the
    // client whose run this is (Lumina is the client project's subject).
    const compared = snapshot!.comparison.map((c) => c.name);
    expect(compared).toContain("Acme");
    expect(compared).not.toContain("Lumina");
    // Stakes are measured recommendation moments, never estimates: the mock
    // recommends rivals in every answer while the prospect never appears.
    expect(snapshot?.stakes).toBeDefined();
    expect(snapshot?.stakes?.yourRecommendations).toBe(0);
    expect(snapshot?.stakes?.recommendationMomentsTotal).toBeGreaterThan(0);
    expect(snapshot?.stakes?.competitorsNamed).toContain("Acme");
    // No volume+sides signals in this seed → no fabricated average deal.
    expect(snapshot?.stakes?.avgDealUsd).toBeNull();
    // Prospect-facing diagnoses shipped; internal research-gap keys did not.
    expect(snapshot?.whyItHappens?.length).toBeGreaterThan(0);
    expect(JSON.stringify(snapshot?.whyItHappens)).not.toContain("gap in our research");
  });

  it("publishes without the gap section when authority has no signals — never a one-sided gap", async () => {
    const { prospectId } = await seedAll();
    const [benchmark] = await sql`
      select id from prospect_benchmarks where prospect_id = ${prospectId}
    `;
    unwrap(await svc.generateFindings(operator, { benchmarkId: benchmark?.id as string }));
    const [candidate] = await sql`
      select id from prospect_findings
      where prospect_id = ${prospectId} and status = 'candidate'
      order by rank_score desc limit 1
    `;
    unwrap(
      await svc.reviewFinding(operator, {
        findingId: candidate?.id as string,
        decision: "approved",
        makePrimary: true,
      })
    );
    const { accessToken } = unwrap(await svc.publishAudit(operator, { prospectId }));
    const snapshot = await svc.getAuditByToken(accessToken);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.authorityGap).toBeUndefined();
  });
});
