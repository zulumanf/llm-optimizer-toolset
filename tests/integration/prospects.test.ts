/**
 * Integration tests for spec 032 — the prospect acquisition vertical slice
 * over a real scored run: launch → prospect → signals → benchmark link →
 * findings → approval → audit page + token → outreach draft → recording plan
 * → pipeline with exclusivity gating → history/activities/immutability.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
const clientViewer: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000002",
  email: "client@test.local",
  name: "Client",
  role: "client_viewer",
};

describe.skipIf(!TEST_URL)("prospect acquisition (integration)", () => {
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
    mock = await import("@/lib/ai/mock");
    await seedTestActors(sql);
    // seedTestActors gives every fixture admin; role gates in these tests
    // come from the CurrentUser literals above, but the client role must be
    // real in the DB for the auth tests to be honest.
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
    // Spec 052: draft generation fails closed without a configured sender.
    const { setSenderIdentity } = await import("@/lib/outreach/sender-identity");
    await sql`truncate outreach_sender_identity`;
    const identity = await setSenderIdentity(admin, {
      senderName: "Dana Operator",
      companyName: "AVOS Agency LLC",
      postalAddress: "123 Grand St, Jersey City, NJ 07302",
      replyToEmail: "dana@avos.agency",
    });
    if (!identity.ok) throw new Error(identity.error.message);
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


  /**
   * A scored run where "Acme Realty" dominates recommendations and the
   * prospect company "Rivera Team" never appears (the mock's default answer
   * recommends Acme and the subject Lumina only). 2 prompts × 3 reps = 6
   * valid responses — above MIN_RESPONSES_FOR_FINDINGS.
   */
  async function seedScoredRun(): Promise<{ runId: string; prospectCompanyId: string }> {
    const subject = unwrap(await companySvc.upsertCompany(operator, { name: "Lumina" }));
    unwrap(await companySvc.upsertCompany(operator, { name: "Acme" }));
    const rivera = unwrap(await companySvc.upsertCompany(operator, { name: "Rivera Team" }));
    const project = unwrap(await projectSvc.createProject(operator, { name: "Client A" }));
    unwrap(
      await claims.setSubjectCompany(operator, {
        projectId: project.id,
        companyId: subject.id,
      })
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
    const run = unwrap(
      await runSvc.startRun(operator, {
        projectId: project.id,
        promptSetVersionId: version?.id as string,
        providers: [{ provider: "mock", model: "mock-model", repetitions: 3 }],
        budgetUsd: 5,
        label: "prospect benchmark run",
      })
    );
    await drainJobs();
    return { runId: run.id, prospectCompanyId: rivera.id };
  }

  async function seedLaunchAndProspect(
    prospectCompanyId: string | null
  ): Promise<{ launchId: string; prospectId: string; marketId: string }> {
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
        companyId: prospectCompanyId,
        teamLeader: "Ana Rivera",
      })
    );
    return {
      launchId: launch.launchId,
      prospectId: prospect.prospectId,
      marketId: market.marketId,
    };
  }

  it("runs the full slice: benchmark → finding → audit → draft → recording plan", async () => {
    const { runId, prospectCompanyId } = await seedScoredRun();
    const { prospectId } = await seedLaunchAndProspect(prospectCompanyId);

    // Authority signal (publicly sourced, with URL)
    unwrap(
      await svc.addAuthoritySignal(operator, {
        prospectId,
        kind: "ranking",
        label: "Ranked #2 Manhattan team by 2025 closed volume (The Real Deal)",
        sourceUrl: "https://example.com/ranking",
        provenance: "publicly_sourced",
      })
    );

    // Link benchmark; refuse a second identical link
    const { benchmarkId } = unwrap(await svc.linkBenchmark(operator, { prospectId, runId }));
    const dup = await svc.linkBenchmark(operator, { prospectId, runId });
    expect(dup.ok).toBe(false);

    // Metrics come straight from `scores`
    const metrics = await svc.benchmarkMetrics(benchmarkId);
    expect(metrics.prospect).not.toBeNull();
    expect(metrics.prospect?.mentionRate).toBe(0);
    expect(metrics.prospect?.sampleSize).toBeGreaterThanOrEqual(6);
    const acme = metrics.others.find((o) => o.name === "Acme");
    expect(acme?.recommendationRate).toBeGreaterThan(0.5);

    // Findings: generated, evidence-linked, ranked
    const generated = unwrap(await svc.generateFindings(operator, { benchmarkId }));
    expect(generated.candidateCount).toBeGreaterThan(0);
    const candidates = await sql`
      select id, kind, response_ids, status from prospect_findings
      where prospect_id = ${prospectId} and status = 'candidate'
      order by rank_score desc
    `;
    expect(candidates.length).toBe(generated.candidateCount);
    for (const c of candidates) {
      expect((c.responseIds as string[]).length).toBeGreaterThan(0);
    }
    // Evidence ids point at real captured responses of that run
    const evidenceIds = candidates.flatMap((c) => c.responseIds as string[]);
    const [evidenced] = await sql`
      select count(*)::int as n from responses
      where id = any(${evidenceIds}::uuid[]) and run_id = ${runId}
    `;
    expect(evidenced?.n).toBe(new Set(evidenceIds).size);

    // Approve the top candidate as primary
    const primary = candidates[0]!;
    unwrap(
      await svc.reviewFinding(operator, {
        findingId: primary.id as string,
        decision: "approved",
        makePrimary: true,
      })
    );

    // Publish audit → token resolves → view recorded
    const { auditId, accessToken } = unwrap(
      await svc.publishAudit(operator, { prospectId })
    );
    expect(accessToken.length).toBeGreaterThanOrEqual(40); // 32 bytes base64url

    const snapshot = await svc.getAuditByToken(accessToken, { userAgent: "vitest" });
    expect(snapshot).not.toBeNull();
    expect(snapshot?.prospectName).toBe("Rivera Team");
    // P3 honesty: the headline total must decompose into teams + brands.
    expect(
      (snapshot?.stakes?.teamRecommendations ?? 0) +
        (snapshot?.stakes?.brandRecommendations ?? 0)
    ).toBe(snapshot?.stakes?.recommendationMomentsTotal);
    // Second person everywhere a prospect reads (P2).
    expect(JSON.stringify(snapshot)).not.toMatch(/the prospect/i);
    expect(snapshot?.benchmark.responseCount).toBeGreaterThanOrEqual(6);
    // Snapshot carries no internal fields
    expect(JSON.stringify(snapshot)).not.toContain("qualification");
    // Instrument stamp (spec 065): the snapshot records the methodology
    // versions its numbers were computed with.
    expect(snapshot?.instrumentVersions?.scoring.length).toBeGreaterThan(0);
    expect(snapshot?.instrumentVersions?.parser.length).toBeGreaterThan(0);
    // Collection provenance (spec 086): the snapshot states how the answers
    // were collected, derived from stored instrument facts. A mock/API run
    // is method 'api'; the search/model-only split covers every response;
    // a prospect project measures for prospecting.
    expect(snapshot?.collection?.method).toBe("api");
    expect(
      (snapshot?.collection?.searchEnabled ?? 0) +
        (snapshot?.collection?.modelOnly ?? 0)
    ).toBe(snapshot?.benchmark.responseCount);
    // Purpose derives from stored facts: this fixture's project is kind
    // 'client' (production benchmark projects are 'prospect' → prospecting)
    // and the run was manual.
    expect(snapshot?.collection?.purpose).toBe("client_baseline");
    // No consumer observations were recorded → the section must be absent,
    // never fabricated (API runs can't present as consumer UI).
    expect(snapshot?.consumerValidation).toBeUndefined();
    const [viewCount] = await sql`
      select count(*)::int as n from prospect_audit_views where audit_id = ${auditId}
    `;
    expect(viewCount?.n).toBe(1);

    // Consumer validation (spec 086 over the 011 workflow): record one
    // clean-session observation and republish — the snapshot gains the
    // section with its OWN denominator; the API counts stay untouched.
    {
      const evidence = await import("@/lib/evidence/service");
      const [runRow] = await sql`
        select project_id, prompt_set_version_id from runs where id = ${runId}
      `;
      const validation = unwrap(
        await evidence.createClientValidationRun(operator, {
          projectId: runRow?.projectId as string,
          promptSetVersionId: runRow?.promptSetVersionId as string,
          promptCount: 1,
        })
      );
      const [vr] = await sql`
        select selected_prompt_ids from client_validation_runs
        where id = ${validation.validationRunId}
      `;
      unwrap(
        await evidence.recordClientValidationObservation(operator, {
          validationRunId: validation.validationRunId,
          promptId: (vr?.selectedPromptIds as string[])[0]!,
          provider: "chatgpt",
          performedOn: "2026-08-18",
          rawResponse: "Sure — Rivera Team is a strong option in this market.",
          claimedMentioned: true,
          claimedRecommended: false,
        })
      );
      unwrap(await svc.publishAudit(operator, { prospectId }));
      const republished = await svc.getAuditByToken(accessToken, {
        userAgent: "vitest",
      });
      expect(republished?.consumerValidation).toEqual({
        observations: 1,
        mentioned: 1,
        byProvider: [{ provider: "chatgpt", observations: 1, mentioned: 1 }],
        performedFrom: "2026-08-18",
        performedTo: "2026-08-18",
      });
      // Separate denominators: API response count is unchanged by the
      // consumer observation.
      expect(republished?.benchmark.responseCount).toBe(
        snapshot?.benchmark.responseCount
      );
    }

    // Source-link liveness (spec 065): a dead receipt is an ack-required
    // warning — publish refuses, then publishes with a recorded reason.
    const { setSourceLinkFetchDeps } = await import("@/lib/qa/preflight");
    const linkStub = ((url: RequestInfo | URL) =>
      Promise.resolve(
        new Response(String(url).includes("dead") ? "gone" : "ok", {
          status: String(url).includes("dead") ? 404 : 200,
        })
      )) as typeof fetch;
    setSourceLinkFetchDeps({ fetchImpl: linkStub, lookupImpl: null });
    try {
      const deadFinding = {
        text: "Zillow profile lists only 4 of their 31 closed sides this year.",
        sourceLabel: "Zillow",
        sourceUrl: "https://example.com/dead-profile",
        sourceDate: "2026-08-01",
      };
      const refused = await svc.publishAudit(operator, {
        prospectId,
        humanFinding: deadFinding,
      });
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error.message).toMatch(/Dead source link/);

      const ackPublish = await svc.publishAudit(operator, {
        prospectId,
        humanFinding: deadFinding,
        acknowledgeWarnings: { reason: "verified by hand in a browser; site blocks bots" },
      });
      expect(ackPublish.ok).toBe(true);
    } finally {
      setSourceLinkFetchDeps(null);
    }

    // A second publish supersedes in place and keeps the link (057) — the
    // dedicated stable-link test covers the full semantics.
    const second = await svc.publishAudit(operator, { prospectId });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.data.accessToken).toBe(accessToken);

    // Wrong token → null
    expect(await svc.getAuditByToken("nonsense-token-nonsense-token")).toBeNull();

    // Revoked token stops working immediately (revoke targets the LIVE
    // audit — the first one is now superseded)
    const liveAuditId = second.ok ? second.data.auditId : auditId;
    unwrap(await svc.revokeAudit(operator, { auditId: liveAuditId, reason: "content superseded" }));
    expect(await svc.getAuditByToken(accessToken)).toBeNull();

    // Draft: generated from the approved finding, versioned, approved, sent
    const draft = unwrap(await svc.createOutreachDraft(operator, { prospectId, channel: "email" }));
    expect(draft.version).toBe(1);
    const [draftRow] = await sql`
      select body, generated_by from outreach_drafts where id = ${draft.draftId}
    `;
    expect(draftRow?.generatedBy).toBe("system");
    expect(draftRow?.body as string).toContain("Rivera Team");
    unwrap(await svc.approveOutreachDraft(operator, { draftId: draft.draftId }));
    // Approved body is immutable at the DB level
    await expect(
      sql`update outreach_drafts set body = 'tampered' where id = ${draft.draftId}`
    ).rejects.toThrow(/immutable/);
    unwrap(await svc.recordDraftSent(operator, { draftId: draft.draftId }));
    const again = await svc.recordDraftSent(operator, { draftId: draft.draftId });
    expect(again.ok).toBe(false);

    // Editing after approval = new version
    const v2 = unwrap(
      await svc.createOutreachDraft(operator, {
        prospectId,
        channel: "email",
        body: "Hi Ana — shorter follow-up angle, same evidence.",
        subject: "One Manhattan benchmark result",
      })
    );
    expect(v2.version).toBe(2);

    // Recording plan
    const plan = unwrap(await svc.generateRecordingPlan(operator, { prospectId }));
    const [planRow] = await sql`
      select script, status from screen_recording_plans where id = ${plan.planId}
    `;
    expect(planRow?.script as string).toContain("0:00–0:20");
    unwrap(await svc.setRecordingStatus(operator, { planId: plan.planId, status: "recorded" }));

    // Timeline exists for every step
    const activities = await sql`
      select kind from prospect_activities where prospect_id = ${prospectId}
    `;
    const kinds = activities.map((a) => a.kind);
    for (const expected of [
      "created",
      "signal_added",
      "benchmark_linked",
      "findings_generated",
      "finding_approved",
      "audit_published",
      "audit_viewed",
      "audit_revoked",
      "draft_created",
      "draft_approved",
      "draft_sent_recorded",
      "recording_plan_generated",
    ]) {
      expect(kinds).toContain(expected);
    }
  });

  it("refuses benchmark links without a company or without scores", async () => {
    const { runId } = await seedScoredRun();
    const { launchId } = await seedLaunchAndProspect(null);
    const [p] = await sql`
      select id from prospects where launch_id = ${launchId}
    `;
    const noCompany = await svc.linkBenchmark(operator, {
      prospectId: p?.id as string,
      runId,
    });
    expect(noCompany.ok).toBe(false);
    if (!noCompany.ok) expect(noCompany.error.message).toMatch(/canonical company/);

    // A company that exists but was never scored in the run
    const ghost = unwrap(await companySvc.upsertCompany(operator, { name: "Ghost Team" }));
    const prospect2 = unwrap(
      await svc.createProspect(operator, {
        launchId,
        businessName: "Ghost Team",
        companyId: ghost.id,
      })
    );
    // Ghost was created after the run's parse: no scores rows
    const [scored] = await sql`
      select count(*)::int as n from scores where company_id = ${ghost.id}
    `;
    if (scored?.n === 0) {
      const unscored = await svc.linkBenchmark(operator, {
        prospectId: prospect2.prospectId,
        runId,
      });
      expect(unscored.ok).toBe(false);
      if (!unscored.ok) expect(unscored.error.message).toMatch(/not scored/);
    }
  });

  it("last mile: default expiry, expire-now, internal views, and the draft carries the audit link (plan 3.x)", async () => {
    const { runId, prospectCompanyId } = await seedScoredRun();
    const { prospectId } = await seedLaunchAndProspect(prospectCompanyId);
    const { benchmarkId } = unwrap(await svc.linkBenchmark(operator, { prospectId, runId }));
    unwrap(await svc.generateFindings(operator, { benchmarkId }));
    const [candidate] = await sql`
      select id from prospect_findings
      where prospect_id = ${prospectId} order by created_at asc limit 1
    `;
    unwrap(
      await svc.reviewFinding(operator, {
        findingId: candidate?.id as string,
        decision: "approved",
        makePrimary: true,
      })
    );

    const { auditId, accessToken } = unwrap(
      await svc.publishAudit(operator, { prospectId })
    );

    // 3.4: publishing without an explicit expiry still sets one.
    const [audit] = await sql`
      select expires_at from prospect_audits where id = ${auditId}
    `;
    expect(audit?.expiresAt).not.toBeNull();

    // 3.6: a staff QA open is labeled internal and not logged as interest.
    await svc.getAuditByToken(accessToken, { internal: true });
    await svc.getAuditByToken(accessToken, { userAgent: "prospect-browser" });
    const [views] = await sql`
      select
        count(*) filter (where is_internal)::int as internal,
        count(*) filter (where not is_internal)::int as external
      from prospect_audit_views where audit_id = ${auditId}
    `;
    expect(views?.internal).toBe(1);
    expect(views?.external).toBe(1);

    // 3.1: with APP_URL set, the generated draft carries the audit link.
    vi.stubEnv("APP_URL", "https://avos.example.com");
    try {
      const draft = unwrap(
        await svc.createOutreachDraft(operator, { prospectId, channel: "email" })
      );
      const [draftRow] = await sql`
        select body from outreach_drafts where id = ${draft.draftId}
      `;
      // Spec 076: drafts embed the BRANDED link (slug + short key), falling
      // back to the token URL only for prospects minted before the feature.
      const { auditLinkForProspect } = await import("@/lib/prospects/links");
      const branded = await auditLinkForProspect(prospectId);
      expect(branded).not.toBeNull();
      expect(draftRow?.body as string).toContain(
        `https://avos.example.com/audit/${branded?.slug}/${branded?.key}`
      );
      expect(draftRow?.body as string).toContain('reply "show me"');
    } finally {
      vi.unstubAllEnvs();
    }

    // 3.4: expire-now kills the token while the audit stays published.
    unwrap(await svc.expireAudit(operator, { auditId }));
    expect(await svc.getAuditByToken(accessToken)).toBeNull();
    const [after] = await sql`
      select status from prospect_audits where id = ${auditId}
    `;
    expect(after?.status).toBe("published");
    // Expiring twice is a refusal, not a silent no-op.
    const twice = await svc.expireAudit(operator, { auditId });
    expect(twice.ok).toBe(false);
  });

  it("republishing keeps the link; revoking burns it (migration 057)", async () => {
    const { runId, prospectCompanyId } = await seedScoredRun();
    const { prospectId } = await seedLaunchAndProspect(prospectCompanyId);
    const { benchmarkId } = unwrap(await svc.linkBenchmark(operator, { prospectId, runId }));
    unwrap(await svc.generateFindings(operator, { benchmarkId }));
    const [candidate] = await sql`
      select id from prospect_findings
      where prospect_id = ${prospectId} order by created_at asc limit 1
    `;
    unwrap(
      await svc.reviewFinding(operator, {
        findingId: candidate?.id as string,
        decision: "approved",
        makePrimary: true,
      })
    );

    const first = unwrap(await svc.publishAudit(operator, { prospectId }));

    // Republish: SAME link, new snapshot row; the old row is superseded,
    // frozen, and its token slot vacated.
    const second = unwrap(await svc.publishAudit(operator, { prospectId }));
    expect(second.accessToken).toBe(first.accessToken);
    expect(second.auditId).not.toBe(first.auditId);
    const [oldRow] = await sql`
      select status, access_token from prospect_audits where id = ${first.auditId}
    `;
    expect(oldRow?.status).toBe("superseded");
    expect(oldRow?.accessToken).toBeNull();
    // The link resolves to the NEW snapshot only.
    expect(await svc.getAuditByToken(second.accessToken, { internal: true })).not.toBeNull();
    // Superseded snapshots stay as immutable as published ones.
    await expect(
      sql`update prospect_audits set headline = 'tampered' where id = ${first.auditId}`
    ).rejects.toThrow(/immutable/);

    // Revoke burns the link: the next publish mints a FRESH token.
    unwrap(await svc.revokeAudit(operator, { auditId: second.auditId, reason: "pulled" }));
    expect(await svc.getAuditByToken(second.accessToken, { internal: true })).toBeNull();
    const third = unwrap(await svc.publishAudit(operator, { prospectId }));
    expect(third.accessToken).not.toBe(second.accessToken);
  });

  it("refuses benchmark links to runs with mock captures outside the harness (plan 2.3)", async () => {
    const { runId, prospectCompanyId } = await seedScoredRun();
    const { prospectId } = await seedLaunchAndProspect(prospectCompanyId);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VITEST", "");
    vi.stubEnv("ALLOW_MOCK_PROVIDER", "");
    try {
      const refused = await svc.linkBenchmark(operator, { prospectId, runId });
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error.message).toMatch(/mock-provider/);
    } finally {
      vi.unstubAllEnvs();
    }
    // Back under the harness the same link succeeds.
    const linked = await svc.linkBenchmark(operator, { prospectId, runId });
    expect(linked.ok).toBe(true);
  });

  it("enforces evidence and wording on finding approval (service and DB)", async () => {
    const { runId, prospectCompanyId } = await seedScoredRun();
    const { prospectId } = await seedLaunchAndProspect(prospectCompanyId);
    const { benchmarkId } = unwrap(await svc.linkBenchmark(operator, { prospectId, runId }));

    // Hand-crafted candidate without evidence cannot be approved
    const [bare] = await sql`
      insert into prospect_findings
        (prospect_id, benchmark_id, kind, title, explanation, generator_version)
      values (${prospectId}, ${benchmarkId}, 'absence', 'No evidence here',
        'An unsupported assertion.', 'test')
      returning id
    `;
    const noEvidence = await svc.reviewFinding(operator, {
      findingId: bare?.id as string,
      decision: "approved",
    });
    expect(noEvidence.ok).toBe(false);
    if (!noEvidence.ok) expect(noEvidence.error.message).toMatch(/evidence/);

    // The DB CHECK backs the service up even against direct SQL
    await expect(
      sql`update prospect_findings set status = 'approved' where id = ${bare?.id}`
    ).rejects.toThrow();

    // Prohibited wording cannot be approved
    const [rid] = await sql`select id from responses where run_id = ${runId} limit 1`;
    const [loud] = await sql`
      insert into prospect_findings
        (prospect_id, benchmark_id, kind, title, explanation, response_ids,
         generator_version)
      values (${prospectId}, ${benchmarkId}, 'absence',
        'This gap is costing you deals',
        'Unverifiable revenue claim.', ${[rid?.id as string]}, 'test')
      returning id
    `;
    const banned = await svc.reviewFinding(operator, {
      findingId: loud?.id as string,
      decision: "approved",
    });
    expect(banned.ok).toBe(false);
    if (!banned.ok) expect(banned.error.message).toMatch(/prohibited wording/);

    // Prohibited wording also blocks draft approval
    unwrap(await svc.generateFindings(operator, { benchmarkId }));
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
    const loudDraft = unwrap(
      await svc.createOutreachDraft(operator, {
        prospectId,
        channel: "email",
        body: "Our revolutionary platform stops you losing deals.",
      })
    );
    const draftBanned = await svc.approveOutreachDraft(operator, { draftId: loudDraft.draftId });
    expect(draftBanned.ok).toBe(false);
  });

  it("keeps exactly one primary approved finding per prospect", async () => {
    const { runId, prospectCompanyId } = await seedScoredRun();
    const { prospectId } = await seedLaunchAndProspect(prospectCompanyId);
    const { benchmarkId } = unwrap(await svc.linkBenchmark(operator, { prospectId, runId }));
    unwrap(await svc.generateFindings(operator, { benchmarkId }));
    const candidates = await sql`
      select id from prospect_findings
      where prospect_id = ${prospectId} and status = 'candidate' limit 2
    `;
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    unwrap(
      await svc.reviewFinding(operator, {
        findingId: candidates[0]?.id as string,
        decision: "approved",
        makePrimary: true,
      })
    );
    unwrap(
      await svc.reviewFinding(operator, {
        findingId: candidates[1]?.id as string,
        decision: "approved",
        makePrimary: true,
      })
    );
    const primaries = await sql`
      select id from prospect_findings
      where prospect_id = ${prospectId} and is_primary and status = 'approved'
    `;
    expect(primaries.length).toBe(1);
    expect(primaries[0]?.id).toBe(candidates[1]?.id);
  });

  it("gates pipeline progression on exclusivity: block, admin override, history", async () => {
    const { prospectId, marketId } = await seedLaunchAndProspect(null);

    // A protected market: active agreement for a client scoped to Manhattan
    const client = unwrap(await projectSvc.createProject(operator, { name: "Existing Client" }));
    unwrap(
      await exclusivity.createAgreement(admin, {
        projectId: client.id,
        startsOn: "2026-01-01",
        gracePeriodDays: 0,
        scopes: [{ marketId }],
      })
    );

    // Ladder up to the gate
    unwrap(await svc.transitionStage(operator, { prospectId, toStage: "qualified" }));

    // Crossing the gate runs a check and blocks
    const blocked = await svc.transitionStage(operator, { prospectId, toStage: "outreach_ready" });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.message).toMatch(/conflict/i);
    const [afterBlock] = await sql`
      select stage, conflict_status, last_exclusivity_check_id from prospects
      where id = ${prospectId}
    `;
    expect(afterBlock?.stage).toBe("qualified");
    expect(["direct", "partial", "possible"]).toContain(afterBlock?.conflictStatus);
    expect(afterBlock?.lastExclusivityCheckId).not.toBeNull();

    // Operator cannot override
    const opOverride = await svc.transitionStage(operator, {
      prospectId,
      toStage: "outreach_ready",
      override: true,
      overrideRationale: "client said it is fine",
    });
    expect(opOverride.ok).toBe(false);

    // Admin override without rationale refused; with rationale allowed
    const noRationale = await svc.transitionStage(admin, {
      prospectId,
      toStage: "outreach_ready",
      override: true,
    });
    expect(noRationale.ok).toBe(false);
    unwrap(
      await svc.transitionStage(admin, {
        prospectId,
        toStage: "outreach_ready",
        override: true,
        overrideRationale: "Agreement ends next month; client approved in writing.",
      })
    );
    const [afterOverride] = await sql`
      select stage, conflict_status from prospects where id = ${prospectId}
    `;
    expect(afterOverride?.stage).toBe("outreach_ready");
    expect(afterOverride?.conflictStatus).toBe("override");

    // Both transitions produced history; the override one carries the check
    const history = await sql`
      select from_stage, to_stage, exclusivity_check_id from prospect_stage_history
      where prospect_id = ${prospectId} order by changed_at asc
    `;
    expect(history.length).toBe(2);
    expect(history[1]?.exclusivityCheckId).not.toBeNull();

    // History is immutable
    await expect(
      sql`update prospect_stage_history set to_stage = 'contracted'
        where prospect_id = ${prospectId}`
    ).rejects.toThrow();
  });

  it("clears the gate when no agreement conflicts", async () => {
    const { prospectId } = await seedLaunchAndProspect(null);
    unwrap(await svc.transitionStage(operator, { prospectId, toStage: "qualified" }));
    unwrap(await svc.transitionStage(operator, { prospectId, toStage: "outreach_ready" }));
    const [row] = await sql`
      select conflict_status from prospects where id = ${prospectId}
    `;
    expect(row?.conflictStatus).toBe("clear");
  });

  it("respects do-not-contact everywhere", async () => {
    const { runId, prospectCompanyId } = await seedScoredRun();
    const { prospectId } = await seedLaunchAndProspect(prospectCompanyId);
    const { benchmarkId } = unwrap(await svc.linkBenchmark(operator, { prospectId, runId }));
    unwrap(await svc.generateFindings(operator, { benchmarkId }));
    const [candidate] = await sql`
      select id from prospect_findings
      where prospect_id = ${prospectId} and status = 'candidate' limit 1
    `;
    unwrap(
      await svc.reviewFinding(operator, {
        findingId: candidate?.id as string,
        decision: "approved",
        makePrimary: true,
      })
    );
    const draft = unwrap(await svc.createOutreachDraft(operator, { prospectId, channel: "email" }));

    unwrap(
      await svc.updateProspect(operator, {
        prospectId,
        doNotContact: true,
        doNotContactReason: "Asked us not to reach out",
      })
    );

    const approve = await svc.approveOutreachDraft(operator, { draftId: draft.draftId });
    expect(approve.ok).toBe(false);
    unwrap(await svc.transitionStage(operator, { prospectId, toStage: "qualified" }));
    unwrap(await svc.transitionStage(operator, { prospectId, toStage: "outreach_ready" }));
    const contact = await svc.transitionStage(operator, { prospectId, toStage: "contacted" });
    expect(contact.ok).toBe(false);
    if (!contact.ok) expect(contact.error.message).toMatch(/do-not-contact/);
  });

  it("denies client roles on every write surface", async () => {
    const { prospectId, launchId, marketId } = await seedLaunchAndProspect(null);
    const attempts = [
      svc.createLaunch(clientViewer, { name: "X", marketId }),
      svc.createProspect(clientViewer, { launchId, businessName: "Y" }),
      svc.updateProspect(clientViewer, { prospectId, notes: "peek" }),
      svc.addAuthoritySignal(clientViewer, {
        prospectId,
        kind: "ranking",
        label: "z",
        provenance: "manual",
      }),
      svc.transitionStage(clientViewer, { prospectId, toStage: "qualified" }),
      svc.publishAudit(clientViewer, { prospectId }),
      svc.createOutreachDraft(clientViewer, { prospectId, channel: "email", body: "hi" }),
      svc.generateRecordingPlan(clientViewer, { prospectId }),
      svc.addActivityNote(clientViewer, { prospectId, note: "hello" }),
    ];
    for (const attempt of await Promise.all(attempts)) {
      expect(attempt.ok).toBe(false);
      if (!attempt.ok) expect(attempt.error.kind).toBe("forbidden");
    }
  });

  it("spec 052: operator-text blocks are fenced — sources required, prohibited wording refused", async () => {
    const { runId, prospectCompanyId } = await seedScoredRun();
    const { prospectId } = await seedLaunchAndProspect(prospectCompanyId);
    const { benchmarkId } = unwrap(await svc.linkBenchmark(operator, { prospectId, runId }));
    unwrap(await svc.generateFindings(operator, { benchmarkId }));
    const [candidate] = await sql`
      select id from prospect_findings
      where prospect_id = ${prospectId} and status = 'candidate' limit 1
    `;
    unwrap(
      await svc.reviewFinding(operator, {
        findingId: candidate?.id as string,
        decision: "approved",
        makePrimary: true,
      })
    );

    // Sources are required — spec 045 §2b as written, not as softened.
    const unsourced = await svc.publishAudit(operator, {
      prospectId,
      humanFinding: { text: "Their site has no press page despite 12 press mentions." },
    });
    expect(unsourced.ok).toBe(false);

    // Prohibited wording in the highest-persuasion block refuses.
    const banned = await svc.publishAudit(operator, {
      prospectId,
      humanFinding: {
        text: "You are losing revenue every week this stays unfixed and it costs you deals.",
        sourceLabel: "The Real Deal",
        sourceUrl: "https://therealdeal.com/example",
        sourceDate: "2026-07-01",
      },
    });
    expect(banned.ok).toBe(false);
    if (!banned.ok) expect(banned.error.message).toMatch(/prohibited wording/i);

    // Fully sourced, clean text publishes and lands in the frozen snapshot.
    const published = unwrap(
      await svc.publishAudit(operator, {
        prospectId,
        humanFinding: {
          text: "Their newest neighborhood guide is from 2023 — assistants cite fresher rival pages.",
          sourceLabel: "riverateam.com/guides",
          sourceUrl: "https://riverateam.com/guides",
          sourceDate: "2026-08-01",
        },
      })
    );
    const [audit] = await sql`
      select snapshot from prospect_audits where id = ${published.auditId}
    `;
    const snapshot = audit?.snapshot as {
      humanFinding?: { sourceUrl: string; sourceDate: string };
    };
    expect(snapshot.humanFinding?.sourceUrl).toBe("https://riverateam.com/guides");
    expect(snapshot.humanFinding?.sourceDate).toBe("2026-08-01");
  });

  it("expires audit tokens and keeps views/activities insert-only", async () => {
    const { runId, prospectCompanyId } = await seedScoredRun();
    const { prospectId } = await seedLaunchAndProspect(prospectCompanyId);
    const { benchmarkId } = unwrap(await svc.linkBenchmark(operator, { prospectId, runId }));
    unwrap(await svc.generateFindings(operator, { benchmarkId }));
    const [candidate] = await sql`
      select id from prospect_findings
      where prospect_id = ${prospectId} and status = 'candidate' limit 1
    `;
    unwrap(
      await svc.reviewFinding(operator, {
        findingId: candidate?.id as string,
        decision: "approved",
        makePrimary: true,
      })
    );
    const { auditId, accessToken } = unwrap(await svc.publishAudit(operator, { prospectId }));
    expect(await svc.getAuditByToken(accessToken)).not.toBeNull();

    // Expiry (expires_at is not a locked column; revocation fields aside,
    // published content stays immutable)
    await sql`update prospect_audits set expires_at = now() - interval '1 hour'
      where id = ${auditId}`;
    expect(await svc.getAuditByToken(accessToken)).toBeNull();

    // Published snapshot cannot be tampered with
    await expect(
      sql`update prospect_audits set snapshot = '{}'::jsonb where id = ${auditId}`
    ).rejects.toThrow(/immutable/);

    // Views and activities refuse UPDATE/DELETE
    const [view] = await sql`
      select id from prospect_audit_views where audit_id = ${auditId} limit 1
    `;
    expect(view).toBeDefined();
    await expect(
      sql`update prospect_audit_views set is_internal = true where id = ${view?.id}`
    ).rejects.toThrow();
    await expect(
      sql`delete from prospect_activities where prospect_id = ${prospectId}`
    ).rejects.toThrow();
  });

  /** Launch-fix regressions (2026-08-14): shared setup — a linked, approved,
   * publishable prospect over a freshly scored run. */
  async function publishableProspect(): Promise<{
    runId: string;
    prospectId: string;
  }> {
    const { runId, prospectCompanyId } = await seedScoredRun();
    const { prospectId } = await seedLaunchAndProspect(prospectCompanyId);
    const { benchmarkId } = unwrap(await svc.linkBenchmark(operator, { prospectId, runId }));
    unwrap(await svc.generateFindings(operator, { benchmarkId }));
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
    return { runId, prospectId };
  }

  it("transcript completeness: total stamped; a capped appendix is disclosed, never claimed complete (launch fix 1)", async () => {
    const { AUDIT_TRANSCRIPT_CAP } = await import("@/lib/prospects/constants");
    const { runId, prospectId } = await publishableProspect();

    // Complete case: the snapshot holds every qualifying capture and says so.
    const full = unwrap(await svc.publishAudit(operator, { prospectId }));
    const fullSnap = await svc.getAuditByToken(full.accessToken, { userAgent: "vitest" });
    expect(fullSnap?.transcripts?.length).toBe(6);
    expect(fullSnap?.transcriptTotal).toBe(6);

    // Blow past the cap with valid captures; the republished snapshot must
    // carry the true total so the pages state shown-of-total, not "all".
    const [seed] = await sql`
      select prompt_id, prompt_text from responses where run_id = ${runId} limit 1
    `;
    await sql`
      insert into responses
        (run_id, prompt_id, prompt_text, provider, model, repetition, response_text)
      select ${runId}, ${seed?.promptId}, ${seed?.promptText}, 'mock', 'mock-model',
        100 + g, 'Filler answer number ' || g
      from generate_series(1, ${AUDIT_TRANSCRIPT_CAP - 5}) as g
    `;
    const capped = unwrap(await svc.publishAudit(operator, { prospectId }));
    const cappedSnap = await svc.getAuditByToken(capped.accessToken, { userAgent: "vitest" });
    expect(cappedSnap?.transcriptTotal).toBe(6 + AUDIT_TRANSCRIPT_CAP - 5);
    expect(cappedSnap?.transcripts?.length).toBe(AUDIT_TRANSCRIPT_CAP);
    expect(cappedSnap?.transcriptTotal ?? 0).toBeGreaterThan(
      cappedSnap?.transcripts?.length ?? 0
    );
  });

  it("partial-run integrity: failed cells never count, partial needs a recorded reason, unfinished runs are hard-blocked (launch fix 2)", async () => {
    const { runId, prospectId } = await publishableProspect();

    // Two failed cells: one on an asked prompt, one on a prompt with no
    // valid capture at all — the failed-only prompt must not count as
    // asked-and-answered.
    const [seed] = await sql`
      select prompt_id, prompt_text from responses where run_id = ${runId} limit 1
    `;
    await sql`
      insert into responses
        (run_id, prompt_id, prompt_text, provider, model, repetition, error)
      values
        (${runId}, ${seed?.promptId}, ${seed?.promptText}, 'mock', 'mock-model', 90,
          ${sql.json({ message: "timeout" })}),
        (${runId}, ${randomUUID()}, 'which team should I avoid in manhattan?',
          'mock', 'mock-model', 1, ${sql.json({ message: "timeout" })})
    `;
    await sql`
      update runs set status = 'partial', status_detail = '2 of 8 cells failed'
      where id = ${runId}
    `;

    // Refused without an acknowledgment…
    const refused = await svc.publishAudit(operator, { prospectId });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toMatch(/incomplete/);

    // …publishable with a recorded reason, and the numbers stay honest:
    // 2 prompts actually answered (not 3), 6 valid answers (not 8).
    const acked = unwrap(
      await svc.publishAudit(operator, {
        prospectId,
        acknowledgeWarnings: {
          reason: "provider flake verified; captured cells representative",
        },
      })
    );
    const snap = await svc.getAuditByToken(acked.accessToken, { userAgent: "vitest" });
    expect(snap?.benchmark.promptCount).toBe(2);
    expect(snap?.benchmark.responseCount).toBe(6);
    expect(snap?.transcriptTotal).toBe(6);
    expect(snap?.transcripts?.length).toBe(6);
    // The acknowledgment and the incompleteness warning are in the audit log.
    const [logged] = await sql`
      select detail from audit_log
      where action = 'prospect.audit_publish' and entity_id = ${acked.auditId}
    `;
    expect(JSON.stringify(logged?.detail)).toContain("incomplete");
    expect(JSON.stringify(logged?.detail)).toContain("captured cells representative");

    // Still-running and failed runs are hard blocks — no acknowledgment path.
    await sql`update runs set status = 'running', status_detail = null where id = ${runId}`;
    const running = await svc.publishAudit(operator, {
      prospectId,
      acknowledgeWarnings: { reason: "trying to force through the gate" },
    });
    expect(running.ok).toBe(false);
    if (!running.ok) expect(running.error.message).toMatch(/only a finished run/);
    await sql`update runs set status = 'failed' where id = ${runId}`;
    const failed = await svc.publishAudit(operator, {
      prospectId,
      acknowledgeWarnings: { reason: "trying to force through the gate" },
    });
    expect(failed.ok).toBe(false);
  });

  it("prompt echo: whole-word matching keeps common-word brands' organic recommendations (launch fix 4)", async () => {
    const bench = await import("@/lib/prospects/benchmark");
    const { PROMPT_ECHO_EXCLUDED } = await import("@/lib/scoring/prompt-echo");
    const { runId } = await seedScoredRun();
    const compass = unwrap(await companySvc.upsertCompany(operator, { name: "Compass" }));
    const remax = unwrap(
      await companySvc.upsertCompany(operator, { name: "RE/MAX (NJ) Collection" })
    );

    const [seed] = await sql`
      select prompt_id from responses where run_id = ${runId} limit 1
    `;
    const crafted = [
      // "encompassing" CONTAINS "compass" — substring matching wrongly
      // treated this as Compass-echo and suppressed the recommendation.
      {
        text: "Which brokerage offers the most encompassing service in Manhattan?",
        company: compass.id,
      },
      // A prompt that truly names the brand as a word stays excluded.
      { text: "Is Compass the best brokerage in Manhattan?", company: compass.id },
      // Regex metacharacters in a name must match literally, not error.
      {
        text: "How good is RE/MAX (NJ) Collection at luxury sales?",
        company: remax.id,
      },
    ];
    for (const [i, c] of crafted.entries()) {
      const [resp] = await sql`
        insert into responses
          (run_id, prompt_id, prompt_text, provider, model, repetition, response_text)
        values (${runId}, ${seed?.promptId}, ${c.text}, 'mock', 'mock-model',
          ${50 + i}, 'You should work with them.')
        returning id
      `;
      await sql`
        insert into mentions
          (response_id, company_id, mentioned, recommended, parser_version, confidence)
        values (${resp?.id}, ${c.company}, true, true, 'test-fixture-v1', 1)
      `;
    }

    // The stakes/excerpt counting rule (publishAudit's idiom), verbatim.
    const rows = await sql`
      select c.name, count(*)::int as organic_recs
      from mentions m
      join companies c on c.id = m.company_id
      join responses r on r.id = m.response_id
      where r.run_id = ${runId} and r.error is null and m.recommended
        and ${bench.CURRENT} and ${PROMPT_ECHO_EXCLUDED}
      group by c.name
    `;
    const byName = new Map(rows.map((r) => [r.name as string, Number(r.organicRecs)]));
    expect(byName.get("Compass")).toBe(1); // the "encompassing" answer counts
    expect(byName.has("RE/MAX (NJ) Collection")).toBe(false); // pure echo drops out

    // The same rule through valuableVisibility's shared predicate: only the
    // prompt that NAMED Compass is a branded (excluded) cell.
    const vv = await bench.valuableVisibility(runId, compass.id);
    expect(vv.brandedExcluded).toBe(1);
  });
});
