/**
 * Integration tests for spec 077 — the sense-check over the real pipeline
 * with a fake model caller: storage (success and failure rows), and the
 * publish-gate matrix (absent = advisory, concern + matching hash = ack
 * required, stale hash = advisory, polish never gates).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import type { AgentCaller } from "@/lib/ai/agent";
import { seedTestActors } from "../helpers/actors";
import { truncateAll } from "../helpers/db";
import { unwrap } from "../helpers/result";
import {
  seedApprovedFinding,
  type PipelineModules,
} from "../helpers/prospect-fixtures";

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

const HUMAN_FINDING = {
  text: "Your site lists 14 closed sales this quarter; none appear in AI answers.",
  sourceLabel: "riverateam.com/track-record",
  sourceUrl: "https://example.com/track-record",
  sourceDate: "2026-08-15",
};

function cannedCaller(output: unknown): AgentCaller {
  return async () => ({
    text: JSON.stringify(output),
    tokensIn: 100,
    tokensOut: 50,
  });
}

const CLEAN = {
  concerns: [],
  overallReadsFair: true,
  confidence: 0.9,
  confidenceNote: "Full content supplied.",
};

const CONCERNED = {
  concerns: [
    {
      severity: "concern",
      area: "overreach",
      detail: "The headline overstates what the metrics table shows.",
      quote: null,
    },
    {
      severity: "polish",
      area: "copy",
      detail: "The explanation repeats the team name three times.",
      quote: null,
    },
  ],
  overallReadsFair: false,
  confidence: 0.8,
  confidenceNote: "Metrics supplied without sample sizes.",
};

describe.skipIf(!TEST_URL)("audit sense-check (integration)", () => {
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
  let sense: typeof import("@/lib/prospects/sense-check");
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
    sense = await import("@/lib/prospects/sense-check");
    mock = await import("@/lib/ai/mock");
    await seedTestActors(sql);
  });

  beforeEach(async () => {
    await sql.unsafe(
      `truncate audit_log, jobs, audit_sense_checks, prospect_audit_links, llm_calls,
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

  function modules(): PipelineModules {
    return {
      sql, projectSvc, setSvc, promptSvc, runSvc, execute, jobs,
      companySvc, claims, parsing, scoring, exclusivity, svc,
    };
  }

  /** Shared fixture: scored prospect run through finding approval. */
  async function seedReadyProspect(): Promise<string> {
    const fixture = await seedApprovedFinding(modules(), operator, admin, {
      projectKind: "prospect",
    });
    return fixture.prospectId;
  }

  it("stores results with version, model, and hash; a failed call stores the failure", async () => {
    const prospectId = await seedReadyProspect();

    const good = unwrap(
      await sense.runSenseCheck(operator, { prospectId }, cannedCaller(CONCERNED))
    );
    expect(good.concerns).toHaveLength(2);
    expect(good.agentVersion).toBe("audit-sense-check-v2");
    expect(good.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(good.error).toBeNull();

    const bad = unwrap(
      await sense.runSenseCheck(operator, { prospectId }, async () => ({
        text: "I refuse to answer in JSON",
        tokensIn: 10,
        tokensOut: 10,
      }))
    );
    expect(bad.error).not.toBeNull();
    expect(bad.concerns).toHaveLength(0);

    const [count] = await sql`select count(*)::int as n from audit_sense_checks`;
    expect(Number(count?.n)).toBe(2);
  });

  it("absent check: publish succeeds with an advisory warning only", async () => {
    const prospectId = await seedReadyProspect();
    const published = unwrap(await svc.publishAudit(operator, { prospectId }));
    expect(published.warnings.join(" ")).toMatch(/No sense-check has been run/);
  });

  it("clean, hash-matching check: publish succeeds without sense warnings", async () => {
    const prospectId = await seedReadyProspect();
    unwrap(await sense.runSenseCheck(operator, { prospectId }, cannedCaller(CLEAN)));
    const published = unwrap(await svc.publishAudit(operator, { prospectId }));
    expect(published.warnings.join(" ")).not.toMatch(/[Ss]ense-check/);
  });

  it("concern + matching hash: publish refuses without a reason, ships with one; polish never gates", async () => {
    const prospectId = await seedReadyProspect();
    unwrap(await sense.runSenseCheck(operator, { prospectId }, cannedCaller(CONCERNED)));

    const refused = await svc.publishAudit(operator, { prospectId });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.message).toMatch(/Sense-check \(overreach\)/);
      // The polish item is not among the blockers.
      expect(refused.error.message).not.toMatch(/repeats the team name/);
    }

    const acked = unwrap(
      await svc.publishAudit(operator, {
        prospectId,
        acknowledgeWarnings: { reason: "reviewed the headline against the table; it holds" },
      })
    );
    expect(acked.warnings.join(" ")).toMatch(/Sense-check \(overreach\)/);
  });

  it("stale hash (content changed since the check): advisory only", async () => {
    const prospectId = await seedReadyProspect();
    unwrap(await sense.runSenseCheck(operator, { prospectId }, cannedCaller(CONCERNED)));

    // Publishing WITH a humanFinding the check never read changes the hash:
    // the concern no longer binds, and the operator is told the check is stale.
    const published = unwrap(
      await svc.publishAudit(operator, { prospectId, humanFinding: HUMAN_FINDING })
    );
    expect(published.warnings.join(" ")).toMatch(/changed after its last sense-check/);
    expect(published.warnings.join(" ")).not.toMatch(/Sense-check \(overreach\)/);
  });
});
