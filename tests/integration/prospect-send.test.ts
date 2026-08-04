/**
 * Integration tests for spec 043 — sendProspectDraft: the full gate chain,
 * the insert-only send ledger (refusals included), the manual channel as
 * the human-record path, and the mock channel's transmit requirements.
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

const PURPOSE = "Benchmark findings relevant to their market position.";

describe.skipIf(!TEST_URL)("prospect send gate (integration)", () => {
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
  let suppression: typeof import("@/lib/outreach/suppression");
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
    suppression = await import("@/lib/outreach/suppression");
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
      `truncate audit_log, jobs, suppression_entries, prospect_outreach_sends,
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


  /** Prospect with a primary contact and an APPROVED draft addressed to them. */
  async function seedApprovedDraft(): Promise<{
    prospectId: string;
    draftId: string;
    contactId: string;
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
        label: "send benchmark run",
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
    const contact = unwrap(
      await svc.addContact(operator, {
        prospectId: prospect.prospectId,
        name: "Ana Rivera",
        email: "ana@riverateam.com",
        isPrimary: true,
      })
    );
    const { benchmarkId } = unwrap(
      await svc.linkBenchmark(operator, { prospectId: prospect.prospectId, runId: run.id })
    );
    unwrap(await svc.generateFindings(operator, { benchmarkId }));
    const [candidate] = await sql`
      select id from prospect_findings
      where prospect_id = ${prospect.prospectId} and status = 'candidate'
      order by rank_score desc limit 1
    `;
    unwrap(
      await svc.reviewFinding(operator, {
        findingId: candidate?.id as string,
        decision: "approved",
        makePrimary: true,
      })
    );
    const draft = unwrap(
      await svc.createOutreachDraft(operator, {
        prospectId: prospect.prospectId,
        channel: "email",
        contactId: contact.contactId,
      })
    );
    unwrap(await svc.approveOutreachDraft(operator, { draftId: draft.draftId }));
    return {
      prospectId: prospect.prospectId,
      draftId: draft.draftId,
      contactId: contact.contactId,
    };
  }

  it("mock channel: dispatches with opt-out footer, writes the allowed ledger row, stamps the draft", async () => {
    const { draftId, prospectId } = await seedApprovedDraft();
    const result = unwrap(
      await svc.sendProspectDraft(operator, { draftId, channel: "mock", businessPurpose: PURPOSE })
    );
    expect(result.providerMessageId).toBe("mock-ana@riverateam.com");

    const [ledger] = await sql`
      select channel, recipient_email, allowed, body_hash, business_purpose, gate_verdict
      from prospect_outreach_sends where id = ${result.sendId}
    `;
    expect(ledger).toMatchObject({
      channel: "mock",
      recipientEmail: "ana@riverateam.com",
      allowed: true,
      businessPurpose: PURPOSE,
    });
    expect((ledger?.bodyHash as string).length).toBe(64);
    const verdict = ledger?.gateVerdict as { checks: { name: string; passed: boolean }[] };
    expect(verdict.checks.every((c) => c.passed)).toBe(true);
    expect(verdict.checks.map((c) => c.name)).toContain("opt_out_path");

    const [draft] = await sql`
      select sent_recorded_at from outreach_drafts where id = ${draftId}
    `;
    expect(draft?.sentRecordedAt).not.toBeNull();
    // Ledger is insert-only.
    await expect(
      sql`update prospect_outreach_sends set allowed = false where id = ${result.sendId}`
    ).rejects.toThrow(/immutable|forbid/i);
    // Second send refused — already sent.
    const again = await svc.sendProspectDraft(operator, {
      draftId,
      channel: "mock",
      businessPurpose: PURPOSE,
    });
    expect(again.ok).toBe(false);
    // Activity recorded.
    const kinds = (
      await sql`select kind from prospect_activities where prospect_id = ${prospectId}`
    ).map((a) => a.kind);
    expect(kinds).toContain("draft_sent");
  });

  it("refusals are ledgered evidence: a suppressed recipient blocks the send and leaves an allowed=false row", async () => {
    const { draftId } = await seedApprovedDraft();
    await sql.begin(async (tx) => {
      await suppression.suppress(tx, {
        scope: "email",
        value: "ana.rivera+any@riverateam.com".replace("ana.rivera", "ana"),
        reason: "opt_out",
        userId: operator.id,
      });
    });
    const refused = await svc.sendProspectDraft(operator, {
      draftId,
      channel: "mock",
      businessPurpose: PURPOSE,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toContain("suppressed");

    const [ledger] = await sql`
      select allowed, gate_verdict, provider_message_id from prospect_outreach_sends
      where draft_id = ${draftId}
    `;
    expect(ledger?.allowed).toBe(false);
    expect(ledger?.providerMessageId).toBeNull();
    const verdict = ledger?.gateVerdict as { checks: { name: string; passed: boolean }[] };
    expect(verdict.checks.find((c) => c.name === "suppression")?.passed).toBe(false);
    // Draft NOT stamped — nothing was sent.
    const [draft] = await sql`
      select sent_recorded_at from outreach_drafts where id = ${draftId}
    `;
    expect(draft?.sentRecordedAt).toBeNull();
    // Refusal audited.
    const [audit] = await sql`
      select id from audit_log where action = 'prospect.send_refused'
    `;
    expect(audit).toBeDefined();
  });

  it("gate essentials: business purpose required, unapproved drafts refused, manual channel records without transmitting", async () => {
    const { prospectId, draftId } = await seedApprovedDraft();

    const noPurpose = await svc.sendProspectDraft(operator, {
      draftId,
      channel: "manual",
      businessPurpose: "short",
    });
    expect(noPurpose.ok).toBe(false);

    // A fresh (unapproved) draft cannot be sent.
    const v2 = unwrap(
      await svc.createOutreachDraft(operator, {
        prospectId,
        channel: "followup_email",
        body: "Hi Ana — shorter follow-up angle, same evidence.",
      })
    );
    const unapproved = await svc.sendProspectDraft(operator, {
      draftId: v2.draftId,
      channel: "manual",
      businessPurpose: PURPOSE,
    });
    expect(unapproved.ok).toBe(false);
    if (!unapproved.ok) expect(unapproved.error.message).toContain("approved");

    // Manual channel: gate ledger without a transmission.
    const recorded = unwrap(
      await svc.sendProspectDraft(operator, {
        draftId,
        channel: "manual",
        businessPurpose: PURPOSE,
      })
    );
    expect(recorded.providerMessageId).toBeNull();
    const [ledger] = await sql`
      select channel, allowed from prospect_outreach_sends where id = ${recorded.sendId}
    `;
    expect(ledger).toMatchObject({ channel: "manual", allowed: true });
  });
});
