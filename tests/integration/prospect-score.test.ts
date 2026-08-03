/**
 * Integration tests for spec 039 — assessments, the stored final score with
 * its breakdown, overrides, weight-set switching, and the minScore filter,
 * over a real scored mock run.
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

describe.skipIf(!TEST_URL)("prospect final score (integration)", () => {
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
  let weightsLib: typeof import("@/lib/scoring/weights");
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
    weightsLib = await import("@/lib/scoring/weights");
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
      `truncate audit_log, jobs, prospect_assessments,
       prospect_activities, prospect_stage_history, screen_recording_plans,
       outreach_drafts, prospect_contacts, prospect_audit_views, prospect_audits,
       prospect_findings, prospect_benchmarks, prospect_authority_signals,
       prospects, market_launches,
       exclusivity_checks, exclusivity_scopes, exclusivity_agreements, markets,
       claims, competitors, scores, sources, response_parses, mentions,
       response_citations, brand_candidates, companies, responses, runs,
       prompt_set_versions, prompts, prompt_sets, projects cascade`
    );
    // Weight sets are seeded by the migration; restore the default active row
    // in case a test switched it. Delete extras BEFORE re-activating v1 —
    // the one-active partial unique index forbids a transient second active.
    await sql`delete from scoring_weight_sets where name = 'prospect-final' and version > 1`;
    await sql`update scoring_weight_sets set active = true
      where name = 'prospect-final' and version = 1`;
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

  async function seedAll(): Promise<{ prospectId: string; launchId: string }> {
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
        label: "score benchmark run",
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
      })
    );
    unwrap(await svc.linkBenchmark(operator, { prospectId: prospect.prospectId, runId: run.id }));
    return { prospectId: prospect.prospectId, launchId: launch.launchId };
  }

  it("computes and stores the score with a self-explaining breakdown", async () => {
    const { prospectId } = await seedAll();
    unwrap(
      await svc.addAuthoritySignal(operator, {
        prospectId,
        kind: "ranking",
        label: "Ranked #2 Manhattan team",
        sourceUrl: "https://example.com/ranking",
        provenance: "verified",
      })
    );
    unwrap(
      await svc.addContact(operator, {
        prospectId,
        name: "Ana Rivera",
        email: "ana@riverateam.com",
        isPrimary: true,
      })
    );
    unwrap(
      await svc.recordAssessment(operator, {
        prospectId,
        item: "website_control",
        value: "yes",
      })
    );

    const { score } = unwrap(await svc.computeProspectScore(operator, { prospectId }));
    expect(score).not.toBeNull();

    const [row] = await sql`
      select qualification_score, qualification_breakdown from prospects
      where id = ${prospectId}
    `;
    expect(row?.qualificationScore).toBe(score);
    const breakdown = row?.qualificationBreakdown as {
      weightSet: { name: string; version: number };
      components: Record<string, number | null>;
      missing: string[];
      dataConfidence: number;
      preConfidence: number;
      fixability: { raw: number; categories: { key: string; measured: boolean }[] };
    };
    // The breakdown explains itself: components, weights version, missing.
    expect(breakdown.weightSet).toMatchObject({ name: "prospect-final", version: 1 });
    // Authority: verified ranking = 15.
    expect(breakdown.components.commercialAuthority).toBeCloseTo(15, 10);
    // Prospect never mentioned → visibility 0 → gap = authority.
    expect(breakdown.components.visibilityGap).toBeCloseTo(15, 10);
    // Buying signals land in Phase F — always missing today.
    expect(breakdown.missing).toContain("buyingSignals");
    // Contactability: primary 40 + email 30, provenance manual, no channel.
    expect(breakdown.components.contactability).toBe(70);
    // The stored score is the composite × data confidence, rounded.
    expect(score).toBe(Math.round(breakdown.preConfidence * breakdown.dataConfidence));
    // Audit + activity recorded.
    const [audit] = await sql`
      select id from audit_log where action = 'prospect.score_compute'
        and entity_id = ${prospectId}
    `;
    expect(audit).toBeDefined();
  });

  it("assessment upserts keep one row per item with the latest answer", async () => {
    const { prospectId } = await seedAll();
    unwrap(
      await svc.recordAssessment(operator, { prospectId, item: "website_control", value: "no" })
    );
    unwrap(
      await svc.recordAssessment(operator, { prospectId, item: "website_control", value: "yes" })
    );
    const rows = await sql`
      select value from prospect_assessments
      where prospect_id = ${prospectId} and item = 'website_control'
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]?.value).toBe("yes");
  });

  it("override requires a reason, never erases the computed score, and filters apply the effective value", async () => {
    const { prospectId, launchId } = await seedAll();
    unwrap(await svc.computeProspectScore(operator, { prospectId }));
    const [before] = await sql`
      select qualification_score from prospects where id = ${prospectId}
    `;

    const noReason = await svc.overrideProspectScore(operator, {
      prospectId,
      score: 88,
      reason: "",
    });
    expect(noReason.ok).toBe(false);

    unwrap(
      await svc.overrideProspectScore(operator, {
        prospectId,
        score: 88,
        reason: "Founder relationship — warm path regardless of benchmark.",
      })
    );
    const [after] = await sql`
      select qualification_score, qualification_override, qualification_override_reason
      from prospects where id = ${prospectId}
    `;
    expect(after?.qualificationScore).toBe(before?.qualificationScore); // kept
    expect(after?.qualificationOverride).toBe(88);

    // minScore filters on the EFFECTIVE score (override wins).
    const high = await svc.listProspects({ launchId, minScore: 80 });
    expect(high.map((p) => p.id)).toContain(prospectId);

    unwrap(
      await svc.overrideProspectScore(operator, {
        prospectId,
        score: null,
        reason: "Cleared after discovery call.",
      })
    );
    const cleared = await svc.listProspects({ launchId, minScore: 80 });
    expect(cleared.map((p) => p.id)).not.toContain(prospectId);
    // Both override actions audited.
    const audits = await sql`
      select action from audit_log
      where entity_id = ${prospectId} and action like 'prospect.score_override%'
    `;
    expect(audits.length).toBe(2);
  });

  it("switching the active weight set changes the composite", async () => {
    const { prospectId } = await seedAll();
    unwrap(
      await svc.addContact(operator, {
        prospectId,
        name: "Ana Rivera",
        email: "ana@riverateam.com",
        isPrimary: true,
      })
    );
    const first = unwrap(await svc.computeProspectScore(operator, { prospectId }));

    // v2: contactability is everything.
    await sql`update scoring_weight_sets set active = false where name = 'prospect-final'`;
    await sql`
      insert into scoring_weight_sets (name, version, weights, active)
      values ('prospect-final', 2,
        '{"commercialAuthority": 0, "visibilityGap": 0, "adjustedFixability": 0,
          "competitorAdvantage": 0, "buyingSignals": 0, "contactability": 1}'::jsonb,
        true)
    `;
    const second = unwrap(await svc.computeProspectScore(operator, { prospectId }));
    expect(second.score).not.toBe(first.score);
    const [row] = await sql`
      select qualification_breakdown from prospects where id = ${prospectId}
    `;
    const breakdown = row?.qualificationBreakdown as {
      weightSet: { version: number };
      components: Record<string, number | null>;
      dataConfidence: number;
    };
    expect(breakdown.weightSet.version).toBe(2);
    // Composite = contactability alone (70), × data confidence.
    expect(second.score).toBe(Math.round(70 * breakdown.dataConfidence));
  });

  it("refuses to score with a weight set that does not sum to 1", async () => {
    const { prospectId } = await seedAll();
    await sql`update scoring_weight_sets set active = false where name = 'prospect-final'`;
    await sql`
      insert into scoring_weight_sets (name, version, weights, active)
      values ('prospect-final', 2, '{"contactability": 0.5}'::jsonb, true)
    `;
    const result = await svc.computeProspectScore(operator, { prospectId });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("sums to");
    await expect(weightsLib.getActiveWeightSet("prospect-final")).rejects.toThrow(/sums to/);
  });
});
