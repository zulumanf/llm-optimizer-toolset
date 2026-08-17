/**
 * Integration tests for spec 075 — the audit refresh queue over a real
 * scored pipeline: publish an audit from run 1, finish a scheduled run 2 on
 * the same prospect project, prepare candidates, and prove that (a) nothing
 * prospect-visible changes without the approve click, (b) the click
 * republishes through the real publishAudit with a stable token, and
 * (c) idempotency, supersede, dismissal and lifecycle refusals hold.
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

const HUMAN_FINDING = {
  text: "Your team page lists 14 closed sales this quarter, none of which appear in AI answers.",
  sourceLabel: "riverateam.com/track-record",
  sourceUrl: "https://example.com/track-record",
  sourceDate: "2026-08-15",
};

describe.skipIf(!TEST_URL)("audit refresh queue (integration)", () => {
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
  let refresh: typeof import("@/lib/prospects/refresh");
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
    refresh = await import("@/lib/prospects/refresh");
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
      `truncate audit_log, jobs, audit_refresh_candidates,
       prospect_activities, prospect_stage_history,
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

  interface Fixture {
    projectId: string;
    versionId: string;
    runId: string;
    prospectId: string;
    prospectCompanyId: string;
  }

  /** A prospect-kind project with a scored manual run and a published audit. */
  async function seedPublishedAudit(): Promise<Fixture> {
    const subject = unwrap(await companySvc.upsertCompany(operator, { name: "Lumina" }));
    unwrap(await companySvc.upsertCompany(operator, { name: "Acme" }));
    const rivera = unwrap(await companySvc.upsertCompany(operator, { name: "Rivera Team" }));
    const project = unwrap(
      await projectSvc.createProject(operator, { name: "Prospect market: Manhattan" })
    );
    await sql`update projects set kind = 'prospect' where id = ${project.id}`;
    unwrap(
      await claims.setSubjectCompany(operator, { projectId: project.id, companyId: subject.id })
    );
    const set = unwrap(
      await setSvc.createPromptSet(operator, { projectId: project.id, name: "Set" })
    );
    for (const p of [
      { text: "best luxury team in manhattan?", category: "recommendation" as const },
      { text: "which team should sell my tribeca loft?", category: "recommendation" as const },
    ]) {
      unwrap(await promptSvc.addPrompt(operator, { setId: set.id, ...p }));
    }
    unwrap(await setSvc.freezePromptSet(operator, { id: set.id }));
    const [version] = await sql`
      select id from prompt_set_versions where prompt_set_id = ${set.id}
    `;
    const versionId = version?.id as string;

    const run = unwrap(
      await runSvc.startRun(operator, {
        projectId: project.id,
        promptSetVersionId: versionId,
        providers: [{ provider: "mock", model: "mock-model", repetitions: 3 }],
        budgetUsd: 5,
        label: "initial benchmark",
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
        priceSegment: "luxury",
        serviceCategory: "residential brokerage",
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
    const { benchmarkId } = unwrap(
      await svc.linkBenchmark(operator, { prospectId: prospect.prospectId, runId: run.id })
    );
    unwrap(await svc.generateFindings(operator, { benchmarkId }));
    const [top] = await sql`
      select id from prospect_findings
      where benchmark_id = ${benchmarkId} and status = 'candidate'
      order by rank_score desc nulls last limit 1
    `;
    unwrap(
      await svc.reviewFinding(operator, {
        findingId: top?.id as string,
        decision: "approved",
        makePrimary: true,
      })
    );
    unwrap(await svc.publishAudit(operator, { prospectId: prospect.prospectId }));
    return {
      projectId: project.id,
      versionId,
      runId: run.id,
      prospectId: prospect.prospectId,
      prospectCompanyId: rivera.id,
    };
  }

  async function startScheduledRun(fixture: Fixture, label: string): Promise<string> {
    const run = unwrap(
      await runSvc.startRun(
        null,
        {
          projectId: fixture.projectId,
          promptSetVersionId: fixture.versionId,
          providers: [{ provider: "mock", model: "mock-model", repetitions: 3 }],
          budgetUsd: 5,
          label,
        },
        "scheduled"
      )
    );
    await drainJobs();
    return run.id;
  }

  it("prepares exactly one pending candidate per published audit, idempotently", async () => {
    const fixture = await seedPublishedAudit();
    const run2 = await startScheduledRun(fixture, "weekly baseline");

    const result = await refresh.prepareAuditRefreshCandidates({ runId: run2 });
    expect(result.notApplicable).toBeUndefined();
    expect(result.prepared).toBe(1);
    expect(result.needsAttention).toBe(0);

    const [candidate] = await sql`
      select id, status, finding_id, delta, preflight from audit_refresh_candidates
      where run_id = ${run2}
    `;
    expect(candidate?.status).toBe("pending");
    expect(candidate?.findingId).not.toBeNull();
    const delta = candidate?.delta as { recommendationRate: { new: number | null } };
    expect(delta.recommendationRate).toBeDefined();
    expect((candidate?.preflight as unknown[]).length).toBeGreaterThan(0);

    // Re-delivery of the same event prepares nothing twice.
    const again = await refresh.prepareAuditRefreshCandidates({ runId: run2 });
    expect(again.prepared).toBe(0);
    expect(again.skipped).toEqual([
      { prospectId: fixture.prospectId, reason: "already_prepared" },
    ]);
  });

  it("safe-skips runs the queue does not consume", async () => {
    const fixture = await seedPublishedAudit();
    // The original run was manual — not the weekly cadence.
    const manual = await refresh.prepareAuditRefreshCandidates({ runId: fixture.runId });
    expect(manual.notApplicable).toMatch(/manual run/);

    // A client-kind project is never the queue's business.
    await sql`update projects set kind = 'client' where id = ${fixture.projectId}`;
    const run2 = await startScheduledRun(fixture, "weekly baseline");
    const wrongKind = await refresh.prepareAuditRefreshCandidates({ runId: run2 });
    expect(wrongKind.notApplicable).toMatch(/kind is client/);
  });

  it("changes nothing prospect-visible until the click, then republishes with a stable token", async () => {
    const fixture = await seedPublishedAudit();
    const [before] = await sql`
      select id, access_token, snapshot from prospect_audits
      where prospect_id = ${fixture.prospectId} and status = 'published'
    `;

    const run2 = await startScheduledRun(fixture, "weekly baseline");
    await refresh.prepareAuditRefreshCandidates({ runId: run2 });

    // Preparation alone: same audit, same token, same snapshot.
    const [mid] = await sql`
      select id, access_token, snapshot from prospect_audits
      where prospect_id = ${fixture.prospectId} and status = 'published'
    `;
    expect(mid?.id).toBe(before?.id);
    expect(mid?.accessToken).toBe(before?.accessToken);

    const [candidate] = await sql`
      select id from audit_refresh_candidates where run_id = ${run2}
    `;
    const approved = unwrap(
      await refresh.approveAuditRefresh(operator, {
        candidateId: candidate?.id as string,
        humanFinding: HUMAN_FINDING,
      })
    );
    expect(approved.auditId).not.toBe(before?.id);

    // Supersede-in-place (spec 057): the old audit is superseded and the
    // SAME token now serves the new snapshot.
    const [after] = await sql`
      select id, access_token from prospect_audits
      where prospect_id = ${fixture.prospectId} and status = 'published'
    `;
    expect(after?.id).toBe(approved.auditId);
    expect(after?.accessToken).toBe(before?.accessToken);
    const [old] = await sql`
      select status from prospect_audits where id = ${before?.id}
    `;
    expect(old?.status).toBe("superseded");

    const [decided] = await sql`
      select status, decided_by from audit_refresh_candidates
      where id = ${candidate?.id}
    `;
    expect(decided?.status).toBe("approved");
    expect(decided?.decidedBy).toBe(operator.id);

    // The new published audit's finding came from the new run.
    const [newAudit] = await sql`
      select f.benchmark_id from prospect_audits a
      join prospect_findings f on f.id = a.finding_id
      where a.id = ${approved.auditId}
    `;
    const [newBenchmark] = await sql`
      select run_id from prospect_benchmarks where id = ${newAudit?.benchmarkId}
    `;
    expect(newBenchmark?.runId).toBe(run2);
  });

  it("dismisses on hold, refuses double decisions, supersedes on the next run", async () => {
    const fixture = await seedPublishedAudit();
    const run2 = await startScheduledRun(fixture, "week 1");
    await refresh.prepareAuditRefreshCandidates({ runId: run2 });
    const [c1] = await sql`
      select id from audit_refresh_candidates where run_id = ${run2}
    `;

    unwrap(
      await refresh.dismissAuditRefresh(operator, {
        candidateId: c1?.id as string,
        reason: "not this week",
      })
    );
    const dismissedTwice = await refresh.dismissAuditRefresh(operator, {
      candidateId: c1?.id as string,
    });
    expect(dismissedTwice.ok).toBe(false);
    const approveDecided = await refresh.approveAuditRefresh(operator, {
      candidateId: c1?.id as string,
      humanFinding: HUMAN_FINDING,
    });
    expect(approveDecided.ok).toBe(false);

    // Next week's preparation supersedes any open candidate.
    const run3 = await startScheduledRun(fixture, "week 2");
    await refresh.prepareAuditRefreshCandidates({ runId: run3 });
    const run4 = await startScheduledRun(fixture, "week 3");
    await refresh.prepareAuditRefreshCandidates({ runId: run4 });
    const [w2] = await sql`
      select status from audit_refresh_candidates where run_id = ${run3}
    `;
    const [w3] = await sql`
      select status from audit_refresh_candidates where run_id = ${run4}
    `;
    expect(w2?.status).toBe("superseded");
    expect(w3?.status).toBe("pending");
  });

  it("refuses a promoted prospect and flips the candidate to dismissed", async () => {
    const fixture = await seedPublishedAudit();
    const run2 = await startScheduledRun(fixture, "weekly baseline");
    await refresh.prepareAuditRefreshCandidates({ runId: run2 });
    const [candidate] = await sql`
      select id from audit_refresh_candidates where run_id = ${run2}
    `;

    await sql`
      update prospects set promoted_project_id = ${fixture.projectId}
      where id = ${fixture.prospectId}
    `;
    const refused = await refresh.approveAuditRefresh(operator, {
      candidateId: candidate?.id as string,
      humanFinding: HUMAN_FINDING,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toMatch(/promoted/);
    const [row] = await sql`
      select status from audit_refresh_candidates where id = ${candidate?.id}
    `;
    expect(row?.status).toBe("dismissed");

    // Promoted prospects never get a fresh candidate either.
    const run3 = await startScheduledRun(fixture, "next week");
    const result = await refresh.prepareAuditRefreshCandidates({ runId: run3 });
    expect(result.prepared).toBe(0);
    expect(result.needsAttention).toBe(0);
  });

  it("lists open candidates with the prior humanFinding pre-fill", async () => {
    const fixture = await seedPublishedAudit();
    // Republish with a humanFinding so the pre-fill has a source.
    const run2 = await startScheduledRun(fixture, "week 1");
    await refresh.prepareAuditRefreshCandidates({ runId: run2 });
    const [c1] = await sql`
      select id from audit_refresh_candidates where run_id = ${run2}
    `;
    unwrap(
      await refresh.approveAuditRefresh(operator, {
        candidateId: c1?.id as string,
        humanFinding: HUMAN_FINDING,
      })
    );

    const run3 = await startScheduledRun(fixture, "week 2");
    await refresh.prepareAuditRefreshCandidates({ runId: run3 });
    const items = await refresh.listAuditRefreshCandidates();
    expect(items).toHaveLength(1);
    expect(items[0]?.businessName).toBe("Rivera Team");
    expect(items[0]?.status).toBe("pending");
    expect(items[0]?.findingTitle).toBeTruthy();
    expect(items[0]?.priorHumanFinding?.text).toBe(HUMAN_FINDING.text);
    expect(await refresh.openRefreshCount()).toBe(1);
  });
});
