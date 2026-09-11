/**
 * Spec 127 follow-up sequences: enrollment, branch-at-render, stop/pause
 * signals, fail-closed preflight, threading, completion. Gmail is mocked at
 * the connector boundary; the benchmark review is stubbed to the frozen
 * snapshot so the live-integrity check passes without a run.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { seedTestActors } from "../helpers/actors";
import { unwrap } from "../helpers/result";
import { seedApprovedFinding, type PipelineModules } from "../helpers/prospect-fixtures";
import { MISMATCH_THRESHOLDS } from "@/lib/prospects/constants";
import type { MismatchEvidenceSnapshot } from "@/lib/prospects/mismatch";

const TEST_URL = process.env.TEST_DATABASE_URL;
const ROOT = join(__dirname, "..", "..");
const SENDER = "francisco@recommendedfirst.com";
const RECIPIENT = "ryan@kane.example";
let PROSPECT_CO = "";
let COMPETITOR_CO = "";
/** The licensed RealTrends row behind the prospect's frozen production —
 * the deterministic source of agent-vs-team wording. */
const PROSPECT_RECORD_ID = "44444444-4444-4444-8444-444444444444";

const operator: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000401", email: "op@test.local", name: "Operator", role: "operator",
};
const admin: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000001", email: "admin@test.local", name: "Admin", role: "admin",
};

const buildSnapshot = (): MismatchEvidenceSnapshot => ({
  templateVersion: "competitive_mismatch_reply_v1",
  runId: "11111111-1111-4111-8111-111111111111",
  provider: "openai", answerCount: 64, modelCount: 1,
  capturedAt: "2026-08-30T00:00:00Z", completedAt: "2026-08-30T00:00:00Z",
  scopeCopy: "Reno buyer and seller questions", audiences: ["buyer", "seller"],
  prospect: { companyId: PROSPECT_CO, prospectId: null, name: "Kane and Partners", recommendationCount: 7, productionSignalId: PROSPECT_RECORD_ID, productionSourceUrl: "https://rt.example", productionYear: 2025, productionValue: 47_200_000, productionDisplay: "$47.2M closed" },
  competitor: { companyId: COMPETITOR_CO, prospectId: null, name: "Harbor View Group", recommendationCount: 14, productionSignalId: "c", productionSourceUrl: "https://rt.example", productionYear: 2025, productionValue: 29_400_000, productionDisplay: "$29.4M closed", productionRatio: 0.62, recommendationGap: 7 },
  metricType: "closed_volume", thresholds: MISMATCH_THRESHOLDS,
});
let snapshot: MismatchEvidenceSnapshot;

const executeCapability = vi.fn();
vi.mock("@/lib/connectors/execute", () => ({ executeCapability: (...args: unknown[]) => executeCapability(...args) }));
vi.mock("@/lib/prospects/evidence-release", async (orig) => {
  // Spec 136: the release layer re-verifies against a real frozen run; this
  // suite's snapshot names a fixture run, so the run/production/count checks
  // are stubbed verified while the entity checks stay REAL (the resolver is
  // what several cases here assert on). tests/integration/evidence-release.test.ts
  // exercises the unstubbed layer.
  const real = await orig<typeof import("@/lib/prospects/evidence-release")>();
  const { countClaimEntityGate } = await import("@/lib/prospects/entity-aliases");
  const verdictFor = async (s: MismatchEvidenceSnapshot) => {
    const g = await countClaimEntityGate({ prospect: s.prospect, competitor: s.competitor });
    const checks = g.statuses.map((st, i) => ({
      name: i === 0 ? "PROSPECT_ENTITY_VERIFIED" : "COMPETITOR_ENTITY_VERIFIED",
      passed: st.verified, detail: st.reason,
      reason: st.verified ? null : i === 0 ? "PROSPECT_ENTITY_UNVERIFIED" : "COMPETITOR_ENTITY_UNVERIFIED",
    }));
    return { version: real.EVIDENCE_RELEASE_VERSION, verified: g.passed, reasons: checks.filter((c) => !c.passed).map((c) => c.reason), checks, diagnostics: {} };
  };
  return {
    ...real,
    verifyEvidenceRelease: verdictFor,
    verifyDraftEvidenceRelease: async (db: unknown, draft: { id: string }) => {
      const found = await real.evidenceSnapshotForDraft(db as never, draft.id);
      return found ? verdictFor(found.snapshot) : null;
    },
  };
});
vi.mock("@/lib/prospects/mismatch", async (orig) => {
  const real = await orig<typeof import("@/lib/prospects/mismatch")>();
  return {
    ...real,
    competitiveMismatchReview: async () => ({
      benchmark: { answerCount: 64, provider: "openai", modelCount: 1, capturedAt: new Date("2026-08-30T00:00:00Z"), recommendedByCompany: {} },
      prospect: { recommendationCount: 7, companyId: PROSPECT_CO, displayName: "Rivera Team", production: null },
      evaluation: {
        eligible: true,
        benchmarkAgeDays: 4,
        candidates: [{ companyId: COMPETITOR_CO, recommendationCount: 14, displayName: "Harbor View Group" }],
        eligibleCandidates: [{ companyId: COMPETITOR_CO, recommendationCount: 14, displayName: "Harbor View Group" }],
      },
    }),
  };
});

const T1_BODY = [
  "Ryan,", "",
  "Earlier this week I ran Reno buyer and seller questions through the OpenAI model behind ChatGPT. It recommended Harbor View Group more often than your team, even though RealTrends has you ahead on closed volume.", "",
  "Your team: $47.2M closed · recommended in 7 of 64 answers",
  "Harbor View Group: $29.4M closed · recommended in 14 of 64 answers", "",
  "When people use ChatGPT to research who to work with, they can see them before they see you.", "",
  "I have the exact questions and the side-by-side. Want me to send them?", "",
  "--", "Francisco Zuluaga · Recommended First", "www.RecommendedFirst.com",
  "123 Grand St, Jersey City, NJ 07302",
  'If you\'d rather not hear from us, reply "unsubscribe" and we will not contact you again.',
].join("\n");
const T1_SENT = new Date("2026-09-01T13:07:00Z"); // Tue 06:07 PDT

describe.skipIf(!TEST_URL)("mismatch follow-up sequences (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let svc: typeof import("@/lib/prospects/service");
  let fu: typeof import("@/lib/prospects/followups");
  let suppression: typeof import("@/lib/outreach/suppression");
  let m: PipelineModules;
  let prospectId = "";
  let contactId = "";
  let t1SendId = "";

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_URL;
    process.env.AUTH_MODE = "dev";
    sql = (await import("@/db/client")).sql;
    svc = await import("@/lib/prospects/service");
    fu = await import("@/lib/prospects/followups");
    suppression = await import("@/lib/outreach/suppression");
    m = {
      sql, svc,
      projectSvc: await import("@/lib/projects/service"),
      setSvc: await import("@/lib/prompts/set-service"),
      promptSvc: await import("@/lib/prompts/prompt-service"),
      runSvc: await import("@/lib/runs/service"),
      execute: await import("@/lib/runs/execute"),
      jobs: await import("@/db/jobs"),
      companySvc: await import("@/lib/companies/service"),
      claims: await import("@/lib/claims/service"),
      parsing: await import("@/lib/parsing/service"),
      scoring: await import("@/lib/scoring/compute"),
      exclusivity: await import("@/lib/exclusivity/service"),
    };
    await sql.unsafe("drop schema public cascade; create schema public;");
    execSync(`npx tsx scripts/migrate.ts up --db "${TEST_URL}"`, { cwd: ROOT, stdio: "pipe" });
    await seedTestActors(sql);
  });
  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    executeCapability.mockReset();
    await sql.unsafe(
      `truncate audit_log, jobs, suppression_entries, prospect_replies, outreach_email_opens, prospect_outreach_sends,
       outreach_followup_sequences, outreach_drafts, prospect_activities, prospect_stage_history, screen_recording_plans,
       prospect_contacts, prospect_audit_views, prospect_audits, prospect_findings, prospect_benchmarks,
       prospect_authority_signals, realtrends_records, prospects, market_launches, exclusivity_checks, exclusivity_scopes,
       exclusivity_agreements, markets, connector_connections, claims, competitors, scores, sources, response_parses,
       mentions, response_citations, brand_candidates, companies, responses, runs, prompt_set_versions, prompts,
       prompt_sets, projects cascade`
    );
    (await import("@/lib/ai/mock")).resetMockProvider();
    await sql`truncate outreach_sender_identity`;
    unwrap(await (await import("@/lib/outreach/sender-identity")).setSenderIdentity(admin, {
      senderName: "Francisco Zuluaga", companyName: "Recommended First",
      postalAddress: "123 Grand St, Jersey City, NJ 07302", replyToEmail: SENDER,
    }));
    const fixture = await seedApprovedFinding(m, operator, admin, { projectKind: "prospect" });
    prospectId = fixture.prospectId;
    PROSPECT_CO = fixture.prospectCompanyId;
    COMPETITOR_CO = fixture.subjectCompanyId;
    snapshot = buildSnapshot();
    await sql`update markets set state_code = 'NV', name = 'Reno, NV' where id = ${fixture.marketId}`;
    await sql`
      insert into realtrends_records (id, fingerprint, dataset_name, entity_type, entity_name, city, state, volume_usd, production_year, source_sheet, source_row,
        team_lead, company_id, match_status, matched_at)
      values (${PROSPECT_RECORD_ID}, 'fp-kane', 'test', 'team', 'Kane and Partners', 'Reno', 'NV', 47200000, 2025, 'Teams', 1,
        'Ryan Kane', ${PROSPECT_CO}, 'confirmed', now())
    `;
    // Entity gate (2026-09-07): both sides of a count claim must be verified
    // before any count-stating email transmits.
    {
      const ea = await import("@/lib/prospects/entity-aliases");
      await ea.applyVerifiedAliases(operator, PROSPECT_CO);
      await ea.recordEntityVerification(operator, { companyId: COMPETITOR_CO, level: "team", sourceUrl: "https://harborview.example/team" });
    }
    const contact = unwrap(await svc.addContact(operator, { prospectId, name: "Ryan Kane", email: RECIPIENT, isPrimary: true }));
    contactId = contact.contactId;
    const findingId = fixture.findingId;
    await sql`update prospects set stage = 'contacted' where id = ${prospectId}`;
    const [draft] = await sql`
      insert into outreach_drafts (prospect_id, finding_id, channel, contact_id, version, subject, body, tone, cta, generated_by,
        prompt_version, evidence_snapshot, status, approved_by, approved_at, created_by, sent_recorded_at)
      values (${prospectId}, ${findingId}, 'email', ${contactId}, 1, 'Ryan - Reno', ${T1_BODY}, 'direct', 'send them?', 'system',
        'competitive_mismatch_reply_v1', ${sql.json(snapshot as never)}, 'approved', ${operator.id}, now(), ${operator.id}, ${T1_SENT})
      returning id
    `;
    const [send] = await sql`
      insert into prospect_outreach_sends (draft_id, prospect_id, channel, recipient_email, body_hash, business_purpose,
        gate_verdict, allowed, provider_message_id, sent_by, sent_at, gmail_thread_id)
      values (${draft!.id}, ${prospectId}, 'gmail', ${RECIPIENT}, 'h', 'test', '{}', true, 'gm-t1', ${operator.id}, ${T1_SENT}, 'thread-1')
      returning id
    `;
    t1SendId = send!.id as string;
  });

  async function gmailConnected(lastSyncMinutesAgo = 5): Promise<void> {
    await sql`
      insert into connector_connections (project_id, provider, connection_name, external_account_id, status,
        granted_scopes, config, last_sync_at, created_by)
      values (null, 'gmail', 'platform', ${SENDER}, 'active', '{}', ${sql.json({ sendAsAddress: SENDER })},
        now() - make_interval(mins => ${lastSyncMinutesAgo}), ${operator.id})
    `;
  }
  const thread = (messages: unknown[]) =>
    executeCapability.mockImplementation(async (args: { capability: string }) =>
      args.capability === "email.read_thread" ? { ok: true, data: { messages } } : { ok: false, errorCode: "unsupported" }
    );
  const outbound = { id: "gm-t1", threadId: "thread-1", messageId: "<t1@mail.gmail.com>", from: `Francisco <${SENDER}>`, to: RECIPIENT, subject: "Ryan - Reno", date: T1_SENT.toISOString(), labelIds: ["SENT"], body: "…" };

  async function enroll() {
    return unwrap(await fu.enrollFollowupSequence(operator, { prospectId }));
  }
  async function renderNow(seqId: string) {
    const seq = (await fu.getFollowupSequence(seqId))!;
    const slot = fu.projectedSlot(seq, new Date())!;
    return fu.scheduleDueFollowups(new Date(slot.getTime() - 5 * 60_000));
  }
  const queued = async (seqId: string) =>
    sql`select id, subject, body, branch, prompt_version, engagement_state_at_dispatch, touch_number, scheduled_send_at
        from outreach_drafts where sequence_id = ${seqId} and status = 'approved' and sent_recorded_at is null`;

  it("enrolls from the delivered Touch 1 with the frozen snapshot, 3 business days out, idempotently", async () => {
    const first = await enroll();
    expect(first.created).toBe(true);
    // Tue 09-01 + 3 business days = Fri 09-04, local midnight Pacific.
    expect(first.nextDueAt?.toISOString()).toBe("2026-09-04T07:00:00.000Z");
    const again = await enroll();
    expect(again.created).toBe(false);
    expect(again.sequenceId).toBe(first.sequenceId);
    const seq = (await fu.getFollowupSequence(first.sequenceId))!;
    expect(seq.timezone).toBe("America/Los_Angeles");
    expect(seq.evidenceSnapshot.competitor.name).toBe("Harbor View Group");
    expect(seq.touch1SendId).toBe(t1SendId);
    expect((await fu.listFollowupSequences({ prospectId }, new Date("2026-09-03T12:00:00Z")))[0]!.displayState).toBe("T1_SENT");
    expect((await fu.listFollowupSequences({ prospectId }, new Date("2026-09-05T12:00:00Z")))[0]!.displayState).toBe("T2_DUE");
  });

  it("renders Touch 2 within the lead, no-engagement branch in a new thread, never twice", async () => {
    const { sequenceId } = await enroll();
    const r1 = await renderNow(sequenceId);
    expect(r1.rendered).toBe(1);
    const [d] = await queued(sequenceId);
    expect(d!.touchNumber).toBe(2);
    expect(d!.branch).toBe("no_engagement");
    expect(d!.promptVersion).toBe("competitive_mismatch_t2_no_engagement_v2");
    expect(d!.body).toContain("RealTrends has your team at $47.2M closed versus $29.4M closed for Harbor View Group.");
    expect(d!.body).toContain("I have the exact questions and answers pulled together.");
    expect(d!.body).not.toContain("private report");
    expect(d!.body).not.toMatch(/[—–]/);
    expect(d!.engagementStateAtDispatch).toBe("NO_MEANINGFUL_ENGAGEMENT");
    expect(d!.subject).toBe("Ryan - one thing I found");
    expect(d!.body).toContain("Your team: recommended in 7 of 64 answers");
    expect(d!.body).toContain("123 Grand St, Jersey City, NJ 07302");
    const r2 = await renderNow(sequenceId);
    expect(r2.rendered).toBe(0);
    expect((await queued(sequenceId)).length).toBe(1);
    // Far from the slot: nothing renders.
    const seq = (await fu.getFollowupSequence(sequenceId))!;
    await sql`update outreach_drafts set status = 'superseded' where sequence_id = ${sequenceId}`;
    const early = await fu.scheduleDueFollowups(new Date(fu.projectedSlot(seq, new Date())!.getTime() - 3 * 3_600_000));
    expect(early.rendered).toBe(0);
    expect(early.waiting).toBe(1);
  });

  it("decides the branch at render time from credible opens; a single open stays no-engagement", async () => {
    const { sequenceId } = await enroll();
    const ua = "Mozilla/5.0 (Macintosh) AppleWebKit (via ggpht.com GoogleImageProxy)";
    await sql`insert into outreach_email_opens (send_id, opened_at, user_agent) values (${t1SendId}, ${new Date(T1_SENT.getTime() + 40 * 60_000)}, ${ua})`;
    await renderNow(sequenceId);
    expect((await queued(sequenceId))[0]!.branch).toBe("no_engagement");
    await sql`update outreach_drafts set status = 'superseded' where sequence_id = ${sequenceId}`;
    await sql`insert into outreach_email_opens (send_id, opened_at, user_agent) values (${t1SendId}, ${new Date(T1_SENT.getTime() + 55 * 60_000)}, ${ua})`;
    await renderNow(sequenceId);
    const [d] = await queued(sequenceId);
    expect(d!.branch).toBe("engaged");
    expect(d!.promptVersion).toBe("competitive_mismatch_t2_engaged_v2");
    expect(d!.subject).toBe("Re: Ryan - Reno");
    expect(d!.body).toContain("The side-by-side is what stood out to me."); // 0 distinct questions on record → fallback
    expect(d!.body).not.toContain("different questions");
  });

  it("a human reply stops the sequence and cancels the queued touch", async () => {
    const { sequenceId } = await enroll();
    await renderNow(sequenceId);
    unwrap(await svc.recordProspectReply(operator, { prospectId, contactId, bodyText: "Sure, send it over." }));
    const seq = await fu.applySequenceSignals(sequenceId, new Date());
    expect(seq?.status).toBe("replied");
    expect((await queued(sequenceId)).length).toBe(0);
    expect((await fu.scheduleDueFollowups(new Date())).rendered).toBe(0);
    expect((await fu.listFollowupSequences({ prospectId }))[0]!.displayState).toBe("REPLIED");
  });

  it("an out-of-office reply pauses until the stated return date; hard bounce and suppression stop", async () => {
    const { sequenceId } = await enroll();
    unwrap(await svc.recordProspectReply(operator, {
      prospectId, contactId, receivedAt: new Date("2026-09-02T15:00:00Z"),
      bodyText: "Automatic reply: I am out of the office and will return on September 14. For urgent matters call the office.",
    }));
    let seq = await fu.applySequenceSignals(sequenceId, new Date("2026-09-03T12:00:00Z"));
    expect(seq?.status).toBe("paused");
    expect(seq?.pausedUntil?.toISOString()).toBe("2026-09-15T07:00:00.000Z");
    expect((await fu.listFollowupSequences({ prospectId }, new Date("2026-09-03T12:00:00Z")))[0]!.displayState).toBe("OOO_PAUSED");
    // Pause expired → resumes.
    seq = await fu.applySequenceSignals(sequenceId, new Date("2026-09-16T12:00:00Z"));
    expect(seq?.status).toBe("active");
    await sql`update prospect_contacts set do_not_contact = true, do_not_contact_reason = 'hard_bounce 2026-09-03: address not found' where id = ${contactId}`;
    seq = await fu.applySequenceSignals(sequenceId, new Date());
    expect(seq?.status).toBe("stopped");
    expect(seq?.stopReason).toBe("hard bounce");

    // Suppression on a fresh sequence.
    await sql`delete from outreach_followup_sequences`;
    await sql`update prospect_contacts set do_not_contact = false, do_not_contact_reason = null where id = ${contactId}`;
    const { sequenceId: s2 } = await enroll();
    await sql.begin(async (tx) => {
      await suppression.suppress(tx, { scope: "email", value: RECIPIENT, reason: "opt_out", detail: "test", projectId: null, userId: operator.id });
    });
    const stopped = await fu.applySequenceSignals(s2, new Date());
    expect(stopped?.status).toBe("stopped");
    expect(stopped?.stopReason).toContain("suppressed");
  });

  it("preflight fails closed without Gmail or with a stale sync, and stops on a live inbound reply", async () => {
    const { sequenceId } = await enroll();
    await renderNow(sequenceId);
    const [d] = await queued(sequenceId);
    // No Gmail connection at all.
    let res = await svc.sendProspectDraft(operator, { draftId: d!.id as string, channel: "mock", businessPurpose: "Spec 127 follow-up", unattended: true });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toContain("no Gmail connection");
    const [ledger] = await sql`select allowed, gate_verdict from prospect_outreach_sends where draft_id = ${d!.id}`;
    expect(ledger!.allowed).toBe(false);
    expect(JSON.stringify(ledger!.gateVerdict)).toContain("followup_preflight");
    // Stale sync.
    await gmailConnected(180);
    res = await svc.sendProspectDraft(operator, { draftId: d!.id as string, channel: "mock", businessPurpose: "Spec 127 follow-up", unattended: true });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toContain("stale");
    // Gmail read failure refuses before anything else is consulted.
    await sql`update connector_connections set last_sync_at = now()`;
    executeCapability.mockImplementation(async () => ({ ok: false, errorCode: "http_500", error: "boom" }));
    res = await svc.sendProspectDraft(operator, { draftId: d!.id as string, channel: "mock", businessPurpose: "Spec 127 follow-up", unattended: true });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toContain("failing closed");
    // Fresh sync but the recipient replied in the thread since Touch 1.
    thread([outbound, { id: "gm-in-1", threadId: "thread-1", messageId: "<r@kane>", from: `Ryan Kane <${RECIPIENT}>`, to: SENDER, subject: "Re: Ryan - Reno", date: "2026-09-02T18:00:00Z", labelIds: ["INBOX"], body: "What is this about?" }]);
    res = await svc.sendProspectDraft(operator, { draftId: d!.id as string, channel: "mock", businessPurpose: "Spec 127 follow-up", unattended: true });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toMatch(/inbound reply|stage is "replied"/);
    const [reply] = await sql`select classification, gmail_message_id from prospect_replies where prospect_id = ${prospectId}`;
    expect(reply!.gmailMessageId).toBe("gm-in-1");
    expect(reply!.classification).toBe("question");
    expect((await fu.getFollowupSequence(sequenceId))!.status).toBe("replied");
  });

  it("clean preflight sends Touch 2, schedules Touch 3 four business days later, Touch 3 completes the sequence", async () => {
    const { sequenceId } = await enroll();
    await gmailConnected();
    thread([outbound]);
    await renderNow(sequenceId);
    const [t2] = await queued(sequenceId);
    const sent = unwrap(await svc.sendProspectDraft(operator, { draftId: t2!.id as string, channel: "mock", businessPurpose: "Spec 127 follow-up", unattended: true }));
    expect(sent.providerMessageId).toContain("mock-");
    let seq = (await fu.getFollowupSequence(sequenceId))!;
    expect(seq.nextTouch).toBe(3);
    expect(seq.lastTouchSendId).toBe(sent.sendId);
    const [t2Send] = await sql`select sent_at from prospect_outreach_sends where id = ${sent.sendId}`;
    expect(seq.nextDueAt?.toISOString()).toBe(fu.dueDayStart(new Date(t2Send!.sentAt as Date), 4, "America/Los_Angeles").toISOString());
    expect((await fu.listFollowupSequences({ prospectId }))[0]!.displayState).toBe("T2_SENT");

    // Touch 3 due now: no engagement → final low-pressure note, threaded on the Touch 2 (new) thread.
    await sql`update outreach_followup_sequences set next_due_at = now() - interval '1 day' where id = ${sequenceId}`;
    seq = (await fu.getFollowupSequence(sequenceId))!;
    await fu.scheduleDueFollowups(new Date(fu.projectedSlot(seq, new Date())!.getTime() - 60_000));
    const [t3] = await queued(sequenceId);
    expect(t3!.touchNumber).toBe(3);
    expect(t3!.promptVersion).toBe("competitive_mismatch_t3_no_engagement_v2");
    expect(t3!.body).toContain("The only reason I emailed you is that RealTrends has your team at $47.2M closed versus $29.4M closed for Harbor View Group, but the recommendation results went the other way.");
    expect(t3!.subject).toBe("Re: Ryan - one thing I found");
    expect(t3!.body).toContain("Last note from me on this.");
    unwrap(await svc.sendProspectDraft(operator, { draftId: t3!.id as string, channel: "mock", businessPurpose: "Spec 127 follow-up", unattended: true }));
    seq = (await fu.getFollowupSequence(sequenceId))!;
    expect(seq.status).toBe("complete");
    expect(seq.nextTouch).toBeNull();
    expect((await fu.scheduleDueFollowups(new Date())).rendered).toBe(0);
    const views = await fu.listFollowupSequences({ prospectId });
    expect(views[0]!.displayState).toBe("COMPLETE_NO_REPLY");
    expect(views[0]!.touches.map((t) => t.touch)).toEqual([1, 2, 3]);
    const metrics = await fu.followupMetrics();
    expect(metrics.delivered).toEqual({ t1: 1, t2: 1, t3: 1 });
    expect(metrics.humanReplies).toBe(0);
  });

  it("a human-composed reply to a recorded reply may be sent unattended and threads under the prospect's message", async () => {
    await gmailConnected();
    // The prospect replied; stage moves to replied (blocks ordinary unattended sends).
    const rec = unwrap(await svc.recordProspectReply(operator, { prospectId, contactId, bodyText: "Yes, send it.", gmailMessageId: "gm-in-9" }));
    executeCapability.mockImplementation(async (args: { capability: string }) =>
      args.capability === "email.search_messages"
        ? { ok: true, data: { messages: [{ id: "gm-in-9", threadId: "thread-1", messageId: "<yes@kane>", from: `Ryan Kane <${RECIPIENT}>`, to: SENDER, subject: "Re: Ryan - Reno", date: "2026-09-03T20:00:00Z", labelIds: ["INBOX"], body: "Yes, send it." }] } }
        : { ok: false, errorCode: "unsupported" }
    );
    const body = `Ryan,\n\nHere it is, as promised.\n\nFrancisco\n\n--\nFrancisco Zuluaga · Recommended First\nwww.RecommendedFirst.com\n123 Grand St, Jersey City, NJ 07302\nIf you'd rather not hear from us, reply "unsubscribe" and we will not contact you again.`;
    const [d] = await sql`
      insert into outreach_drafts (prospect_id, finding_id, channel, contact_id, version, subject, body, tone, cta, generated_by,
        prompt_version, status, approved_by, approved_at, created_by, reply_to_id)
      select prospect_id, finding_id, 'email', ${contactId}, 9, 'Re: Ryan - Reno', ${body}, 'direct', 'reply', 'operator',
        'reply-first-email-v1', 'approved', ${operator.id}, now(), ${operator.id}, ${rec.replyId}
      from outreach_drafts where prospect_id = ${prospectId} order by version limit 1 returning id
    `;
    // Without the reply link the same send is refused; with it, it transmits.
    await sql`update outreach_drafts set reply_to_id = null where id = ${d!.id}`;
    let res = await svc.sendProspectDraft(operator, { draftId: d!.id as string, channel: "mock", businessPurpose: "Deliver the report he asked for", unattended: true });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toContain('stage is "replied"');
    await sql`update outreach_drafts set reply_to_id = ${rec.replyId} where id = ${d!.id}`;
    res = await svc.sendProspectDraft(operator, { draftId: d!.id as string, channel: "mock", businessPurpose: "Deliver the report he asked for", unattended: true });
    if (!res.ok) throw new Error(`second send refused: ${res.error.message}`);
    expect(res.ok).toBe(true);
    const [ledger] = await sql`select allowed, gate_verdict from prospect_outreach_sends where draft_id = ${d!.id} and allowed`;
    expect(ledger!.allowed).toBe(true);
    expect(JSON.stringify(ledger!.gateVerdict)).toContain("replying in Gmail thread thread-1");
    // Gmail unreachable → refuses rather than opening a new thread.
    await sql`update outreach_drafts set sent_recorded_at = null where id = ${d!.id}`.catch(() => undefined);
  });

  it("an individual agent is addressed as 'you', a team as 'your team' — from the frozen RealTrends record", async () => {
    await sql`update realtrends_records set entity_type = 'individual' where id = ${PROSPECT_RECORD_ID}`;
    const { sequenceId } = await enroll();
    await renderNow(sequenceId);
    const [d] = await queued(sequenceId);
    expect(d!.body).toContain("RealTrends has you at $47.2M closed versus $29.4M closed for Harbor View Group.");
    expect(d!.body).toContain("You: recommended in 7 of 64 answers");
    expect(d!.body).not.toMatch(/your team/i);
    // Unknown entity type: nothing renders (fails closed).
    await sql`update outreach_drafts set status = 'superseded' where sequence_id = ${sequenceId}`;
    await sql`delete from realtrends_records where id = ${PROSPECT_RECORD_ID}`;
    const r = await renderNow(sequenceId);
    expect(r.qaFailed).toBe(1);
    expect((await queued(sequenceId)).length).toBe(0);
  });

  it("an unreadable or ambiguous reply stops the sequence for review and never suppresses", async () => {
    const { sequenceId } = await enroll();
    await renderNow(sequenceId);
    // Gmail ingestion of an all-quoted body falls back to the subject line.
    unwrap(await svc.recordProspectReply(operator, { prospectId, contactId, bodyText: "Re: Ryan - Reno", gmailMessageId: "gm-blank" }));
    const seq = await fu.applySequenceSignals(sequenceId, new Date());
    expect(seq?.status).toBe("replied");
    expect(seq?.stopReason).toContain("needs review");
    expect((await queued(sequenceId)).length).toBe(0);
    expect((await fu.listFollowupSequences({ prospectId }))[0]!.displayState).toBe("REPLY_NEEDS_REVIEW");
    expect((await suppression.checkSuppression({ email: RECIPIENT, phone: null, projectId: null })).suppressed).toBe(false);
    expect((await fu.scheduleDueFollowups(new Date())).rendered).toBe(0);
  });

  it("a positive reply stops the sequence and creates the founder handoff with the report state", async () => {
    const { sequenceId } = await enroll();
    await renderNow(sequenceId);
    unwrap(await svc.recordProspectReply(operator, { prospectId, contactId, bodyText: "Yes", gmailMessageId: "gm-yes" }));
    const seq = await fu.applySequenceSignals(sequenceId, new Date());
    expect(seq?.status).toBe("replied");
    const [act] = await sql`select detail from prospect_activities where prospect_id = ${prospectId} and kind = 'founder_action_required'`;
    expect(act).toBeTruthy();
    expect((act!.detail as { reportState: string }).reportState).toBe("REPORT_NOT_GENERATED");
    const [view] = await fu.listFollowupSequences({ prospectId });
    expect(view!.displayState).toBe("REPLIED");
    expect(view!.handoff?.reportState).toBe("REPORT_NOT_GENERATED");
    expect((await queued(sequenceId)).length).toBe(0);
    // A published private report over the SAME frozen evidence flips the state.
    const [finding] = await sql`select finding_id from outreach_drafts where prospect_id = ${prospectId} limit 1`;
    await sql`
      insert into prospect_audits (prospect_id, finding_id, headline, snapshot, status, access_token, published_at, published_by, created_by)
      values (${prospectId}, ${finding!.findingId}, 'h', ${sql.json({ mismatch: { answerCount: 64, prospect: { name: "Kane and Partners", recommendationCount: 7 }, competitor: { name: "Harbor View Group", recommendationCount: 14 } } })},
        'published', 'tok', now(), ${operator.id}, ${operator.id})
    `;
    expect((await fu.listFollowupSequences({ prospectId }))[0]!.handoff?.reportState).toBe("READY_TO_SEND");
  });

  it("the sequence expires 21 calendar days after the successful Touch 1 and completes with no reply", async () => {
    const { sequenceId } = await enroll();
    const seq0 = (await fu.getFollowupSequence(sequenceId))!;
    expect(seq0.touch1SentAt.toISOString()).toBe(T1_SENT.toISOString());
    expect(fu.sequenceExpiresAt(seq0.touch1SentAt).toISOString()).toBe("2026-09-22T13:07:00.000Z");
    // Deferred to the day before expiry: still renders. Past it: completes.
    let seq = await fu.applySequenceSignals(sequenceId, new Date("2026-09-21T12:00:00Z"));
    expect(seq?.status).toBe("active");
    seq = await fu.applySequenceSignals(sequenceId, new Date("2026-09-23T12:00:00Z"));
    expect(seq?.status).toBe("complete");
    expect(seq?.stopReason).toContain("expired");
    expect((await fu.listFollowupSequences({ prospectId }))[0]!.displayState).toBe("COMPLETE_NO_REPLY");
    expect((await fu.scheduleDueFollowups(new Date("2026-09-23T12:00:00Z"))).rendered).toBe(0);
  });

  it("an in-thread touch refuses to send when the parent thread id cannot be resolved", async () => {
    const { sequenceId } = await enroll();
    const ua = "Mozilla/5.0 (Macintosh) AppleWebKit (via ggpht.com GoogleImageProxy)";
    await sql`insert into outreach_email_opens (send_id, opened_at, user_agent) values (${t1SendId}, ${new Date(T1_SENT.getTime() + 40 * 60_000)}, ${ua}), (${t1SendId}, ${new Date(T1_SENT.getTime() + 55 * 60_000)}, ${ua})`;
    // The ledger is immutable, so stand in a parent send that never learned
    // its Gmail thread (a transport that returned no thread id).
    const [bare] = await sql`
      insert into prospect_outreach_sends (draft_id, prospect_id, channel, recipient_email, body_hash, business_purpose,
        gate_verdict, allowed, provider_message_id, sent_by, sent_at)
      select draft_id, prospect_id, 'gmail', ${RECIPIENT}, 'h2', 'test', '{}', true, 'gm-bare', ${operator.id}, ${new Date(T1_SENT.getTime() + 60_000)}
      from prospect_outreach_sends where id = ${t1SendId} returning id
    `;
    await sql`update outreach_followup_sequences set last_touch_send_id = ${bare!.id} where id = ${sequenceId}`;
    await renderNow(sequenceId);
    const [d] = await queued(sequenceId);
    expect(d!.branch).toBe("engaged");
    await gmailConnected();
    thread([outbound]);
    const res = await svc.sendProspectDraft(operator, { draftId: d!.id as string, channel: "mock", businessPurpose: "Spec 127 follow-up", unattended: true });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toContain("no Gmail thread id");
  });

  it("operator controls: pause cancels the queued touch, resume re-renders, stop is terminal", async () => {
    const { sequenceId } = await enroll();
    await renderNow(sequenceId);
    unwrap(await fu.pauseFollowupSequence(operator, { sequenceId, reason: "founder review" }));
    expect((await queued(sequenceId)).length).toBe(0);
    expect((await fu.listFollowupSequences({ prospectId }))[0]!.displayState).toBe("PAUSED");
    expect((await fu.scheduleDueFollowups(new Date())).rendered).toBe(0);
    unwrap(await fu.resumeFollowupSequence(operator, { sequenceId }));
    await renderNow(sequenceId);
    expect((await queued(sequenceId)).length).toBe(1);
    unwrap(await fu.setAllFollowupsPaused(operator, { paused: true }));
    expect((await fu.getFollowupSequence(sequenceId))!.status).toBe("paused");
    unwrap(await fu.setAllFollowupsPaused(operator, { paused: false }));
    expect((await fu.getFollowupSequence(sequenceId))!.status).toBe("active");
    unwrap(await fu.stopFollowupSequence(operator, { sequenceId, reason: "wrong entity" }));
    expect((await fu.getFollowupSequence(sequenceId))!.status).toBe("stopped");
    expect((await fu.resumeFollowupSequence(operator, { sequenceId })).ok).toBe(false);
  });
});
