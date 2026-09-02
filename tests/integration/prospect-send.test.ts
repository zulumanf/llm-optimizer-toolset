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
    // Spec 052: cold outreach fails closed without a configured legal sender.
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

  // ------------------------------------------------------------- spec 052

  it("spec 052: send refuses without a configured sender identity", async () => {
    const { draftId } = await seedApprovedDraft();
    await sql`truncate outreach_sender_identity`;
    const refused = await svc.sendProspectDraft(operator, {
      draftId,
      channel: "mock",
      businessPurpose: PURPOSE,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toMatch(/sender identity/i);
    const [ledger] = await sql`
      select allowed, gate_verdict from prospect_outreach_sends order by sent_at desc limit 1
    `;
    expect(ledger?.allowed).toBe(false);
    const checks = (ledger?.gateVerdict as { checks: { name: string; passed: boolean }[] }).checks;
    expect(checks.find((c) => c.name === "sender_identity")?.passed).toBe(false);
  });

  it("spec 052: the same person under another prospect refuses within the window", async () => {
    const { draftId, prospectId } = await seedApprovedDraft();
    unwrap(
      await svc.sendProspectDraft(operator, { draftId, channel: "mock", businessPurpose: PURPOSE })
    );
    // A second prospect with the same human's email, minimal raw seed.
    const [first] = await sql`
      select launch_id from prospects where id = ${prospectId}
    `;
    const [finding] = await sql`select id from prospect_findings limit 1`;
    const [p2] = await sql`
      insert into prospects (launch_id, business_name, prospect_type, email)
      values (${first?.launchId}, 'Harbor Team', 'team', 'ana@riverateam.com')
      returning id
    `;
    const [d2] = await sql`
      insert into outreach_drafts (prospect_id, finding_id, channel, body,
        generated_by, status)
      values (${p2?.id}, ${finding?.id}, 'email', 'Hello — quick note. Reply unsubscribe to opt out.',
        'operator', 'approved')
      returning id
    `;
    const refused = await svc.sendProspectDraft(operator, {
      draftId: d2?.id as string,
      channel: "mock",
      businessPurpose: PURPOSE,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toMatch(/already contacted under another prospect/);
  });

  it("spec 052: the brokerage frequency cap refuses the fourth send", async () => {
    const { draftId, prospectId } = await seedApprovedDraft();
    await sql`update prospects set brokerage_affiliation = 'Compass' where id = ${prospectId}`;
    const [first] = await sql`select launch_id from prospects where id = ${prospectId}`;
    const [finding] = await sql`select id from prospect_findings limit 1`;
    for (let i = 0; i < 3; i += 1) {
      const [p] = await sql`
        insert into prospects (launch_id, business_name, prospect_type, brokerage_affiliation)
        values (${first?.launchId}, ${"Compass Team " + i}, 'team', 'Compass')
        returning id
      `;
      const [d] = await sql`
        insert into outreach_drafts (prospect_id, finding_id, channel, body, generated_by, status)
        values (${p?.id}, ${finding?.id}, 'email', 'x', 'operator', 'approved')
        returning id
      `;
      await sql`
        insert into prospect_outreach_sends (draft_id, prospect_id, channel,
          recipient_email, body_hash, business_purpose, gate_verdict, allowed, sent_by)
        values (${d?.id}, ${p?.id}, 'manual', ${"agent" + i + "@compass.com"}, 'h',
          'seeded', '{"checks":[]}', true, ${operator.id})
      `;
    }
    const refused = await svc.sendProspectDraft(operator, {
      draftId,
      channel: "mock",
      businessPurpose: PURPOSE,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toMatch(/cap is 3/);
  });

  const seedBrokerageSend = async (launchId: string, brokerage: string, i: number) => {
    const [finding] = await sql`select id from prospect_findings limit 1`;
    const [p] = await sql`
      insert into prospects (launch_id, business_name, prospect_type, brokerage_affiliation)
      values (${launchId}, ${`${brokerage} Team ${launchId.slice(0, 4)}-${i}`}, 'team', ${brokerage})
      returning id`;
    const [d] = await sql`
      insert into outreach_drafts (prospect_id, finding_id, channel, body, generated_by, status)
      values (${p?.id}, ${finding?.id}, 'email', 'x', 'operator', 'approved')
      returning id`;
    await sql`
      insert into prospect_outreach_sends (draft_id, prospect_id, channel,
        recipient_email, body_hash, business_purpose, gate_verdict, allowed, sent_by)
      values (${d?.id}, ${p?.id}, 'manual', ${`b${launchId.slice(0, 4)}${i}@example.com`}, 'h',
        'seeded', '{"checks":[]}', true, ${operator.id})`;
  };

  it("spec 120: the cap ignores the same brand in another market", async () => {
    const { draftId, prospectId } = await seedApprovedDraft();
    await sql`update prospects set brokerage_affiliation = 'Compass' where id = ${prospectId}`;
    const [first] = await sql`
      select launch_id, (select market_id from market_launches where id = launch_id) as market_id
      from prospects where id = ${prospectId}`;
    const [other] = await sql`
      insert into market_launches (name, market_id) values ('Elsewhere luxury residential', ${first?.marketId})
      returning id`;
    for (let i = 0; i < 3; i += 1) await seedBrokerageSend(other?.id as string, "Compass", i);
    // Would have refused under the global cap; market scoping lets it pass.
    const sent = await svc.sendProspectDraft(operator, { draftId, channel: "mock", businessPurpose: PURPOSE });
    expect(sent.ok).toBe(true);
  });

  it("spec 120: suffix variants share one in-market cap bucket", async () => {
    const { draftId, prospectId } = await seedApprovedDraft();
    await sql`update prospects set brokerage_affiliation = 'Long & Foster Real Estate' where id = ${prospectId}`;
    const [first] = await sql`select launch_id from prospects where id = ${prospectId}`;
    for (let i = 0; i < 3; i += 1)
      await seedBrokerageSend(first?.launchId as string, "Long & Foster Real Estate Inc.", i);
    const refused = await svc.sendProspectDraft(operator, { draftId, channel: "mock", businessPurpose: PURPOSE });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toMatch(/cap is 3/);
  });

  it("spec 052: a reserved territory blocks at send time; a recorded override passes", async () => {
    const { draftId, prospectId } = await seedApprovedDraft();
    const [market] = await sql`select id from markets limit 1`;
    const [project] = await sql`select id from projects where name = 'Client A'`;
    const today = new Date().toISOString().slice(0, 10);
    unwrap(
      await exclusivity.createAgreement(operator, {
        projectId: project?.id as string,
        startsOn: today,
        status: "reserved",
        scopes: [{ marketId: market?.id as string, serviceCategory: null, segment: null }],
      })
    );
    const refused = await svc.sendProspectDraft(operator, {
      draftId,
      channel: "mock",
      businessPurpose: PURPOSE,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toMatch(/Territory conflict/);

    // A recorded admin override at the stage gate is honored at send time.
    await sql`update prospects set conflict_status = 'override' where id = ${prospectId}`;
    const sent = await svc.sendProspectDraft(operator, {
      draftId,
      channel: "mock",
      businessPurpose: PURPOSE,
    });
    expect(sent.ok).toBe(true);
  });

  it("spec 052: erasure nulls PII, tombstones the suppression list, and is audited", async () => {
    const { contactId, draftId } = await seedApprovedDraft();
    const pii = await import("@/lib/prospects/pii");
    const erased = unwrap(
      await pii.eraseProspectContactPii(admin, {
        contactId,
        reason: "erasure request by email 2026-08-09",
      })
    );
    expect(erased.suppressed).toBe(true);

    const [contact] = await sql`
      select name, email, phone, pii_erased_at from prospect_contacts where id = ${contactId}
    `;
    expect(contact?.name).toBe("[erased]");
    expect(contact?.email).toBeNull();
    expect(contact?.piiErasedAt).not.toBeNull();

    const { checkSuppression } = await import("@/lib/outreach/suppression");
    const suppression = await checkSuppression({
      email: "ana@riverateam.com",
      projectId: null,
    });
    expect(suppression.suppressed).toBe(true);

    const [audit] = await sql`
      select 1 from audit_log where action = 'prospect.contact_pii_erased'
    `;
    expect(audit).toBeDefined();

    // The draft addressed to the erased contact can never send.
    const refused = await svc.sendProspectDraft(operator, {
      draftId,
      channel: "mock",
      businessPurpose: PURPOSE,
    });
    expect(refused.ok).toBe(false);

    // Double-erasure refuses.
    const again = await pii.eraseProspectContactPii(admin, {
      contactId,
      reason: "duplicate request",
    });
    expect(again.ok).toBe(false);
  });

  it("spec 052: the stale-PII report lists only inactive old contacts", async () => {
    const { prospectId } = await seedApprovedDraft();
    const pii = await import("@/lib/prospects/pii");
    // Fresh contact with recent activity → not stale.
    expect(await pii.stalePiiReport(365)).toHaveLength(0);
    // An old, inactive prospect+contact appears.
    const [first] = await sql`select launch_id from prospects where id = ${prospectId}`;
    const [old] = await sql`
      insert into prospects (launch_id, business_name, prospect_type)
      values (${first?.launchId}, 'Dormant Team', 'team') returning id
    `;
    await sql`
      insert into prospect_contacts (prospect_id, name, email, created_at)
      values (${old?.id}, 'Old Contact', 'old@dormant.com', now() - interval '400 days')
    `;
    const report = await pii.stalePiiReport(365);
    expect(report).toHaveLength(1);
    expect(report[0]?.contactName).toBe("Old Contact");
  });

  it("spec 052: audit snapshot evidence validator matches immutable score rows", async () => {
    await seedApprovedDraft();
    const { validateAuditEvidence } = await import("@/lib/prospects/audit-evidence");
    const [score] = await sql`
      select id, value, sample_size from scores where metric = 'mention_rate'
        and provider = 'all' limit 1
    `;
    const row = {
      name: "Rivera Team",
      isProspect: true,
      mentionRate: Number(score?.value),
      recommendationRate: null,
      sampleSize: Number(score?.sampleSize),
      scoreIds: { mention_rate: score?.id as string },
    };
    expect(await validateAuditEvidence({ comparison: [row] })).toHaveLength(0);
    // Tampered value refuses.
    const tampered = await validateAuditEvidence({
      comparison: [{ ...row, mentionRate: Number(score?.value) + 0.5 }],
    });
    expect(tampered.length).toBeGreaterThan(0);
    expect(tampered[0]?.problem).toMatch(/immutable score/);
    // An unbound number refuses.
    const unbound = await validateAuditEvidence({
      comparison: [{ ...row, scoreIds: {} }],
    });
    expect(unbound[0]?.problem).toMatch(/no scores-row reference/);
  });
});
