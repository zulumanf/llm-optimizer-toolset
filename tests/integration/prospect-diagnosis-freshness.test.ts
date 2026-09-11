/**
 * Integration tests for spec 042 — buying signals feeding the final score,
 * the diagnosis read over a real scored run, and the stale-benchmark
 * publish gate.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { seedTestActors } from "../helpers/actors";
import { truncateAll } from "../helpers/db";
import { unwrap } from "../helpers/result";

const TEST_URL = process.env.TEST_DATABASE_URL;

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

describe.skipIf(!TEST_URL)("diagnosis, buying signals, freshness (integration)", () => {
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
  let buying: typeof import("@/lib/prospects/buying-signals");
  let diagnose: typeof import("@/lib/prospects/diagnose");
  let mock: typeof import("@/lib/ai/mock");

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    // File-level clean slate: the shared schema is built once per
    // vitest run, so residue from earlier suites must be cleared here.
    await truncateAll(sql);
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
    buying = await import("@/lib/prospects/buying-signals");
    diagnose = await import("@/lib/prospects/diagnose");
    mock = await import("@/lib/ai/mock");
    await seedTestActors(sql);
  });

  beforeEach(async () => {
    await sql.unsafe(
      `truncate audit_log, jobs, prospect_buying_signals, prospect_assessments,
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


  async function seedBenchmarkedProspect(): Promise<{ prospectId: string; runId: string }> {
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
    for (const text of [
      "best luxury team in manhattan?",
      "which team should sell my tribeca loft?",
    ]) {
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
        projectId: project.id,
        promptSetVersionId: version?.id as string,
        providers: [{ provider: "mock", model: "mock-model", repetitions: 3 }],
        budgetUsd: 5,
        label: "diagnosis run",
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
        website: "https://riverateam.com",
      })
    );
    unwrap(await svc.linkBenchmark(operator, { prospectId: prospect.prospectId, runId: run.id }));
    return { prospectId: prospect.prospectId, runId: run.id };
  }

  it("buying signals require source and date, feed the score, and archive back to not-measured", async () => {
    const { prospectId } = await seedBenchmarkedProspect();

    const noSource = await buying.addBuyingSignal(operator, {
      prospectId,
      kind: "hiring_marketing",
      label: "Marketing manager role posted",
      observedOn: "2026-07-20",
    });
    expect(noSource.ok).toBe(false);
    const noDate = await buying.addBuyingSignal(operator, {
      prospectId,
      kind: "hiring_marketing",
      label: "Marketing manager role posted",
      sourceUrl: "https://example.com/job",
    });
    expect(noDate.ok).toBe(false);

    const today = new Date().toISOString().slice(0, 10);
    const { signalId } = unwrap(
      await buying.addBuyingSignal(operator, {
        prospectId,
        kind: "hiring_marketing",
        label: "Marketing manager role posted",
        sourceUrl: "https://example.com/job",
        observedOn: today,
        provenance: "publicly_sourced",
      })
    );

    unwrap(await svc.computeProspectScore(operator, { prospectId }));
    const [scored] = await sql`
      select qualification_breakdown from prospects where id = ${prospectId}
    `;
    const breakdown = scored?.qualificationBreakdown as {
      components: Record<string, number | null>;
      missing: string[];
    };
    // One fresh publicly-sourced signal: 25 × 0.85.
    expect(breakdown.components.buyingSignals).toBeCloseTo(21.25, 10);
    expect(breakdown.missing).not.toContain("buyingSignals");

    unwrap(await buying.archiveBuyingSignal(operator, { signalId }));
    unwrap(await svc.computeProspectScore(operator, { prospectId }));
    const [rescored] = await sql`
      select qualification_breakdown from prospects where id = ${prospectId}
    `;
    const after = rescored?.qualificationBreakdown as {
      components: Record<string, number | null>;
      missing: string[];
    };
    expect(after.components.buyingSignals).toBeNull();
    expect(after.missing).toContain("buyingSignals");
  });

  it("diagnoses the absent prospect from the real run and reacts to recorded research", async () => {
    const { prospectId, runId } = await seedBenchmarkedProspect();

    const report = await diagnose.diagnoseProspect(prospectId);
    expect(report.benchmarkRunId).toBe(runId);
    const keys = report.diagnoses.map((d) => d.key);
    // Rivera never appears in mock answers → absent everywhere.
    expect(keys).toContain("no_organic_visibility");
    // No research recorded yet → honest low-confidence research gaps.
    expect(keys).toContain("no_review_evidence");
    expect(keys).toContain("no_media_evidence");
    // Mock answers carry no citations → citation diagnoses stay silent.
    expect(keys).not.toContain("missing_from_cited_sources");
    const visibility = report.diagnoses.find((d) => d.key === "no_organic_visibility")!;
    expect(visibility.affectedPrompts.length).toBeGreaterThan(0);
    expect(visibility.suggestedAction.length).toBeGreaterThan(10);

    // Recording review evidence clears the research-gap diagnosis.
    unwrap(
      await svc.addAuthoritySignal(operator, {
        prospectId,
        kind: "review_footprint",
        label: "4.9 average across 212 Google reviews",
        sourceUrl: "https://example.com/reviews",
        provenance: "publicly_sourced",
      })
    );
    const updated = await diagnose.diagnoseProspect(prospectId);
    expect(updated.diagnoses.map((d) => d.key)).not.toContain("no_review_evidence");
  });

  it("a stale benchmark blocks publishing unless explicitly acknowledged — and the acknowledgment is recorded", async () => {
    const { prospectId, runId } = await seedBenchmarkedProspect();
    // Approve a primary finding so publishAudit has its chain.
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

    // Age the run past the 90-day window.
    await sql`update runs set started_at = now() - interval '100 days' where id = ${runId}`;

    const blocked = await svc.publishAudit(operator, { prospectId });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.error.message).toContain("100 days old");
      expect(blocked.error.message).toContain("90-day freshness window");
    }

    const published = unwrap(
      await svc.publishAudit(operator, { prospectId, acknowledgeStale: true })
    );
    expect(published.accessToken.length).toBeGreaterThan(20);
    const [audit] = await sql`
      select detail from audit_log
      where action = 'prospect.audit_publish' and entity_id = ${published.auditId}
    `;
    expect(audit?.detail).toMatchObject({
      staleBenchmarkAcknowledged: true,
      benchmarkAgeDays: 100,
    });

    // A fresh benchmark publishes without any acknowledgment (regression).
    unwrap(await svc.revokeAudit(operator, { auditId: published.auditId, reason: "test reset" }));
    await sql`update runs set started_at = now() - interval '5 days' where id = ${runId}`;
    const fresh = await svc.publishAudit(operator, { prospectId });
    expect(fresh.ok).toBe(true);
  });
});
