/**
 * Integration tests for spec 091 — the gmail channel and scheduled dispatch:
 * the daily cap as a gate check, scheduling as a second explicit human act
 * on an approved draft, and the worker drain's claim discipline (terminal
 * refusals park, clean transport failures retry, ambiguous crashes never
 * auto-retry).
 *
 * The connector layer is mocked at its single door (executeCapability) so
 * transport outcomes are controllable; everything below the channel —
 * gates, ledger, schedule columns, audit — runs against the real database.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { seedTestActors } from "../helpers/actors";
import { unwrap } from "../helpers/result";

vi.mock("@/lib/connectors/execute", () => ({
  executeCapability: vi.fn(),
}));

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

const sendOk = {
  ok: true,
  data: { messageId: "gm-123", threadId: "th-1" },
  provider: "gmail",
  connectionId: "c-1",
};
const sendNoConnection = {
  ok: false,
  error: "No active gmail connection for this client. Connect the provider first.",
  errorCode: "no_connection",
  retryable: false,
  provider: "gmail",
  connectionId: null,
};
const sendHttp500 = {
  ok: false,
  error: "Gmail returned 500",
  errorCode: "http_500",
  retryable: true,
  provider: "gmail",
  connectionId: "c-1",
};

describe.skipIf(!TEST_URL)("gmail channel + scheduled sends (integration)", () => {
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
  let drain: typeof import("@/lib/prospects/scheduled-sends");
  let suppression: typeof import("@/lib/outreach/suppression");
  let constants: typeof import("@/lib/prospects/constants");
  let mock: typeof import("@/lib/ai/mock");
  let executeCapability: ReturnType<typeof vi.fn>;

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
    drain = await import("@/lib/prospects/scheduled-sends");
    suppression = await import("@/lib/outreach/suppression");
    constants = await import("@/lib/prospects/constants");
    mock = await import("@/lib/ai/mock");
    const executeModule = await import("@/lib/connectors/execute");
    executeCapability = executeModule.executeCapability as unknown as ReturnType<typeof vi.fn>;
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
    executeCapability.mockReset();
    const { setSenderIdentity } = await import("@/lib/outreach/sender-identity");
    await sql`truncate outreach_sender_identity`;
    unwrap(
      await setSenderIdentity(admin, {
        senderName: "Dana Operator",
        companyName: "AVOS Agency LLC",
        postalAddress: "123 Grand St, Jersey City, NJ 07302",
        replyToEmail: "dana@avos.agency",
      })
    );
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
  async function seedApprovedDraft(): Promise<{ prospectId: string; draftId: string }> {
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
        label: "gmail send benchmark run",
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
    return { prospectId: prospect.prospectId, draftId: draft.draftId };
  }

  async function scheduleAndBackdate(draftId: string): Promise<void> {
    unwrap(
      await svc.scheduleDraftSend(operator, {
        draftId,
        sendAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        businessPurpose: PURPOSE,
      })
    );
    await sql`
      update outreach_drafts set scheduled_send_at = now() - interval '1 minute'
      where id = ${draftId}
    `;
  }

  it("gmail channel: transmits through the connector and ledgers the send with the cap check", async () => {
    const { draftId } = await seedApprovedDraft();
    executeCapability.mockResolvedValue(sendOk);

    const result = unwrap(
      await svc.sendProspectDraft(operator, { draftId, channel: "gmail", businessPurpose: PURPOSE })
    );
    expect(result.providerMessageId).toBe("gm-123");
    expect(executeCapability).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "email.send_approved_message",
        provider: "gmail",
        projectId: null,
        mode: "live",
        input: expect.objectContaining({ to: "ana@riverateam.com" }),
      })
    );
    // The transmitted body carries the compliant footer.
    const dispatched = executeCapability.mock.calls[0]?.[0] as {
      input: { body: string };
    };
    expect(dispatched.input.body).toMatch(/unsubscribe/i);
    expect(dispatched.input.body).toContain("123 Grand St");

    const [ledger] = await sql`
      select channel, allowed, provider_message_id, gate_verdict
      from prospect_outreach_sends where id = ${result.sendId}
    `;
    expect(ledger).toMatchObject({
      channel: "gmail",
      allowed: true,
      providerMessageId: "gm-123",
    });
    const verdict = ledger?.gateVerdict as {
      version: string;
      checks: { name: string; passed: boolean }[];
    };
    expect(verdict.version).toBe("prospect-send-gate-v2");
    const cap = verdict.checks.find((c) => c.name === "daily_send_cap");
    expect(cap?.passed).toBe(true);

    const [draft] = await sql`
      select sent_recorded_at from outreach_drafts where id = ${draftId}
    `;
    expect(draft?.sentRecordedAt).not.toBeNull();
  });

  it("gmail channel: refuses actionably with no connection, and nothing is recorded as sent", async () => {
    const { draftId } = await seedApprovedDraft();
    executeCapability.mockResolvedValue(sendNoConnection);

    const result = await svc.sendProspectDraft(operator, {
      draftId,
      channel: "gmail",
      businessPurpose: PURPOSE,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("validation");
      expect(result.error.message).toMatch(/No Gmail connection.*connect-gmail/);
    }
    const [draft] = await sql`
      select sent_recorded_at from outreach_drafts where id = ${draftId}
    `;
    expect(draft?.sentRecordedAt).toBeNull();
    const sends = await sql`select id from prospect_outreach_sends where allowed`;
    expect(sends.length).toBe(0);
  });

  it("daily cap: the send past the cap refuses with a ledgered refusal, before any dispatch", async () => {
    const { draftId, prospectId } = await seedApprovedDraft();
    for (let i = 0; i < constants.GMAIL_DAILY_SEND_CAP; i += 1) {
      await sql`
        insert into prospect_outreach_sends
          (draft_id, prospect_id, channel, body_hash, business_purpose,
           gate_verdict, allowed, sent_by)
        values (${draftId}, ${prospectId}, 'gmail', 'seed-hash', ${PURPOSE},
          ${sql.json({ version: "seed", checks: [] } as never)}, true, ${operator.id})
      `;
    }
    const result = await svc.sendProspectDraft(operator, {
      draftId,
      channel: "gmail",
      businessPurpose: PURPOSE,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/daily Gmail cap/);
    expect(executeCapability).not.toHaveBeenCalled();

    const [refusal] = await sql`
      select gate_verdict from prospect_outreach_sends
      where draft_id = ${draftId} and not allowed
    `;
    const verdict = refusal?.gateVerdict as { checks: { name: string; passed: boolean }[] };
    expect(verdict.checks.find((c) => c.name === "daily_send_cap")?.passed).toBe(false);
  });

  it("scheduling: approved + future + bounded, recorded with schedule fields and an audit row", async () => {
    const { draftId } = await seedApprovedDraft();
    const sendAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
    unwrap(
      await svc.scheduleDraftSend(operator, {
        draftId,
        sendAt: sendAt.toISOString(),
        businessPurpose: PURPOSE,
      })
    );
    const [draft] = await sql`
      select scheduled_send_at, scheduled_by, scheduled_business_purpose, send_attempts
      from outreach_drafts where id = ${draftId}
    `;
    expect((draft?.scheduledSendAt as Date).getTime()).toBe(sendAt.getTime());
    expect(draft?.scheduledBy).toBe(operator.id);
    expect(draft?.scheduledBusinessPurpose).toBe(PURPOSE);
    const [audit] = await sql`
      select id from audit_log
      where action = 'prospect.send_scheduled' and entity_id = ${draftId}
    `;
    expect(audit).toBeDefined();

    const past = await svc.scheduleDraftSend(operator, {
      draftId,
      sendAt: new Date(Date.now() - 1000).toISOString(),
      businessPurpose: PURPOSE,
    });
    expect(past.ok).toBe(false);
    if (!past.ok) expect(past.error.message).toMatch(/in the past/);

    const tooFar = await svc.scheduleDraftSend(operator, {
      draftId,
      sendAt: new Date(Date.now() + 31 * 24 * 60 * 60 * 1000).toISOString(),
      businessPurpose: PURPOSE,
    });
    expect(tooFar.ok).toBe(false);
    if (!tooFar.ok) expect(tooFar.error.message).toMatch(/30 days/);

    // Only approved drafts schedule: a fresh (unapproved) version refuses.
    const [existing] = await sql`
      select prospect_id, contact_id, body from outreach_drafts where id = ${draftId}
    `;
    const unapproved = unwrap(
      await svc.createOutreachDraft(operator, {
        prospectId: existing?.prospectId as string,
        channel: "email",
        contactId: existing?.contactId as string,
        body: `${existing?.body as string}\n\nP.S. new version`,
      })
    );
    const refused = await svc.scheduleDraftSend(operator, {
      draftId: unapproved.draftId,
      sendAt: sendAt.toISOString(),
      businessPurpose: PURPOSE,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toMatch(/Only approved/);
  });

  it("cancel clears a pending schedule but refuses while the worker holds a claim", async () => {
    const { draftId } = await seedApprovedDraft();
    unwrap(
      await svc.scheduleDraftSend(operator, {
        draftId,
        sendAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        businessPurpose: PURPOSE,
      })
    );
    unwrap(await svc.cancelScheduledSend(operator, { draftId }));
    const [cleared] = await sql`
      select scheduled_send_at from outreach_drafts where id = ${draftId}
    `;
    expect(cleared?.scheduledSendAt).toBeNull();

    unwrap(
      await svc.scheduleDraftSend(operator, {
        draftId,
        sendAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        businessPurpose: PURPOSE,
      })
    );
    await sql`update outreach_drafts set send_claimed_at = now() where id = ${draftId}`;
    const refused = await svc.cancelScheduledSend(operator, { draftId });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.kind).toBe("conflict");
  });

  it("drain: transmits a due approved draft through the full gate and clears its claim", async () => {
    const { draftId } = await seedApprovedDraft();
    executeCapability.mockResolvedValue(sendOk);
    await scheduleAndBackdate(draftId);

    const report = await drain.drainScheduledSends();
    expect(report).toMatchObject({ due: 1, sent: 1, parked: 0, retryable: 0 });

    const [draft] = await sql`
      select sent_recorded_at, send_claimed_at, sent_recorded_by
      from outreach_drafts where id = ${draftId}
    `;
    expect(draft?.sentRecordedAt).not.toBeNull();
    expect(draft?.sendClaimedAt).toBeNull();
    // Attribution: the scheduling human is the sender of record.
    expect(draft?.sentRecordedBy).toBe(operator.id);
    const [ledger] = await sql`
      select channel, allowed, sent_by from prospect_outreach_sends where draft_id = ${draftId}
    `;
    expect(ledger).toMatchObject({ channel: "gmail", allowed: true, sentBy: operator.id });
  });

  it("drain: a send-time gate change (suppression after approval) parks the draft, never sends", async () => {
    const { draftId } = await seedApprovedDraft();
    executeCapability.mockResolvedValue(sendOk);
    await scheduleAndBackdate(draftId);
    await sql.begin((tx) =>
      suppression.suppress(tx, {
        scope: "email",
        value: "ana@riverateam.com",
        reason: "opt_out",
        projectId: null,
        userId: admin.id,
      })
    );

    const report = await drain.drainScheduledSends();
    expect(report).toMatchObject({ due: 1, sent: 0, parked: 1 });
    expect(executeCapability).not.toHaveBeenCalled();

    const [draft] = await sql`
      select status, sent_recorded_at, scheduled_send_at, last_send_error
      from outreach_drafts where id = ${draftId}
    `;
    expect(draft?.status).toBe("approved");
    expect(draft?.sentRecordedAt).toBeNull();
    expect(draft?.scheduledSendAt).toBeNull();
    expect(draft?.lastSendError).toMatch(/suppress/i);
    // The refusal is ledgered evidence.
    const [refusal] = await sql`
      select id from prospect_outreach_sends where draft_id = ${draftId} and not allowed
    `;
    expect(refusal).toBeDefined();
  });

  it("drain: clean transport failures retry, then park at the attempt cap", async () => {
    const { draftId } = await seedApprovedDraft();
    executeCapability.mockResolvedValue(sendHttp500);
    await scheduleAndBackdate(draftId);

    for (let attempt = 1; attempt < constants.SCHEDULED_SEND_MAX_ATTEMPTS; attempt += 1) {
      const report = await drain.drainScheduledSends();
      expect(report).toMatchObject({ retryable: 1, parked: 0 });
      const [draft] = await sql`
        select send_attempts, scheduled_send_at, send_claimed_at, last_send_error
        from outreach_drafts where id = ${draftId}
      `;
      expect(draft?.sendAttempts).toBe(attempt);
      expect(draft?.scheduledSendAt).not.toBeNull();
      expect(draft?.sendClaimedAt).toBeNull();
      expect(draft?.lastSendError).toMatch(/Gmail dispatch failed/);
    }

    const final = await drain.drainScheduledSends();
    expect(final).toMatchObject({ retryable: 0, parked: 1 });
    const [parked] = await sql`
      select scheduled_send_at, status, sent_recorded_at from outreach_drafts
      where id = ${draftId}
    `;
    expect(parked?.scheduledSendAt).toBeNull();
    expect(parked?.status).toBe("approved");
    expect(parked?.sentRecordedAt).toBeNull();
  });

  it("drain: an outstanding stale claim parks as ambiguous — never auto-retried", async () => {
    const { draftId } = await seedApprovedDraft();
    executeCapability.mockResolvedValue(sendOk);
    await scheduleAndBackdate(draftId);
    await sql`
      update outreach_drafts set send_claimed_at = now() - interval '20 minutes',
        send_attempts = 1
      where id = ${draftId}
    `;

    const report = await drain.drainScheduledSends();
    expect(report).toMatchObject({ due: 1, sent: 0, parked: 1 });
    expect(executeCapability).not.toHaveBeenCalled();
    const [draft] = await sql`
      select scheduled_send_at, last_send_error from outreach_drafts where id = ${draftId}
    `;
    expect(draft?.scheduledSendAt).toBeNull();
    expect(draft?.lastSendError).toMatch(/did not record an outcome/);
  });

  it("drain: never picks up a schedule on anything but an approved, unsent draft", async () => {
    const { draftId } = await seedApprovedDraft();
    // Force the schedule onto a superseded row: approving a NEW version
    // supersedes the old one and clears its schedule.
    await scheduleAndBackdate(draftId);
    const [draft] = await sql`
      select prospect_id, contact_id, body from outreach_drafts where id = ${draftId}
    `;
    const newVersion = unwrap(
      await svc.createOutreachDraft(operator, {
        prospectId: draft?.prospectId as string,
        channel: "email",
        contactId: draft?.contactId as string,
        body: `${draft?.body as string}\n\nP.S. updated`,
      })
    );
    unwrap(await svc.approveOutreachDraft(operator, { draftId: newVersion.draftId }));

    const [superseded] = await sql`
      select status, scheduled_send_at from outreach_drafts where id = ${draftId}
    `;
    expect(superseded?.status).toBe("superseded");
    expect(superseded?.scheduledSendAt).toBeNull();

    const report = await drain.drainScheduledSends();
    expect(report).toMatchObject({ due: 0, sent: 0 });
    expect(executeCapability).not.toHaveBeenCalled();
  });
});
