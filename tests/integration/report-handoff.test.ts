/**
 * Spec 129: a positive reply on a mismatch prospect becomes a published
 * private report, three QA passes, and a threaded reply — or a parked
 * handoff with the reason. Agents are stubbed at the caller boundary; the
 * report is published through the real publishAudit over the followups
 * fixture; Gmail is mocked at the connector boundary.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import type { AgentCaller } from "@/lib/ai/agent";
import { seedTestActors } from "../helpers/actors";
import { unwrap } from "../helpers/result";
import { seedApprovedFinding, type PipelineModules } from "../helpers/prospect-fixtures";
import { MISMATCH_THRESHOLDS } from "@/lib/prospects/constants";
import type { MismatchEvidenceSnapshot } from "@/lib/prospects/mismatch";

const TEST_URL = process.env.TEST_DATABASE_URL;
const ROOT = join(__dirname, "..", "..");
const SENDER = "francisco@recommendedfirst.com";
const RECIPIENT = "ryan@kane.example";
const PROSPECT_RECORD_ID = "44444444-4444-4444-8444-444444444444";
let PROSPECT_CO = "";
let COMPETITOR_CO = "";

const operator: CurrentUser = { id: "00000000-0000-4000-8000-000000000401", email: "op@test.local", name: "Operator", role: "operator" };
const admin: CurrentUser = { id: "00000000-0000-4000-8000-000000000001", email: "admin@test.local", name: "Admin", role: "admin" };

const executeCapability = vi.fn();
vi.mock("@/lib/connectors/execute", () => ({ executeCapability: (...args: unknown[]) => executeCapability(...args) }));
vi.mock("@/lib/prospects/mismatch", async (orig) => {
  const real = await orig<typeof import("@/lib/prospects/mismatch")>();
  return {
    ...real,
    competitiveMismatchReview: async () => ({
      benchmark: { answerCount: 64, provider: "openai", modelCount: 1, capturedAt: new Date("2026-08-30T00:00:00Z"), recommendedByCompany: {} },
      prospect: { recommendationCount: 7, companyId: PROSPECT_CO, displayName: "Rivera Team", production: null },
      evaluation: { eligible: true, benchmarkAgeDays: 4, candidates: [{ companyId: COMPETITOR_CO, recommendationCount: 14, displayName: "Lumina" }], eligibleCandidates: [{ companyId: COMPETITOR_CO, recommendationCount: 14, displayName: "Lumina" }] },
    }),
  };
});

const T1_BODY = [
  "Ryan,", "",
  "Earlier this week I ran Reno buyer and seller questions through the OpenAI model behind ChatGPT. It recommended Lumina more often than your team, even though RealTrends has you ahead on closed volume.", "",
  "Your team: $47.2M closed · recommended in 7 of 64 answers", "Lumina: $29.4M closed · recommended in 14 of 64 answers", "",
  "I have the exact questions and the side-by-side. Want me to send them?", "",
  "--", "Francisco Zuluaga · Recommended First", "www.RecommendedFirst.com", "123 Grand St, Jersey City, NJ 07302",
  'If you\'d rather not hear from us, reply "unsubscribe" and we will not contact you again.',
].join("\n");
const T1_SENT = new Date("2026-09-01T13:07:00Z");

const passingCaller: AgentCaller = async ({ system }) => ({
  text: system.includes("verdict") 
    ? JSON.stringify({ verdict: "send", concerns: [], firstImpression: "Clear and specific.", topQuestion: null, confidence: 0.85, confidenceNote: "Full report supplied." })
    : JSON.stringify({ concerns: [], overallReadsFair: true, confidence: 0.85, confidenceNote: "Full report supplied." }),
  tokensIn: 10, tokensOut: 10,
});
const blockingCaller: AgentCaller = async ({ system }) => ({
  text: system.includes("verdict")
    ? JSON.stringify({ verdict: "fix", concerns: [{ severity: "blocking", area: "jargon", detail: "Uses the word prompt.", quote: "prompt" }], firstImpression: "Confusing.", topQuestion: "What is a prompt?", confidence: 0.9, confidenceNote: "n/a" })
    : JSON.stringify({ concerns: [], overallReadsFair: true, confidence: 0.85, confidenceNote: "n/a" }),
  tokensIn: 10, tokensOut: 10,
});

describe.skipIf(!TEST_URL)("positive-reply report handoff (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let svc: typeof import("@/lib/prospects/service");
  let fu: typeof import("@/lib/prospects/followups");
  let rh: typeof import("@/lib/prospects/report-handoff");
  let m: PipelineModules;
  let prospectId = "";
  let contactId = "";
  let snapshot: MismatchEvidenceSnapshot;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_URL;
    process.env.AUTH_MODE = "dev";
    process.env.APP_URL = "https://app.test.local";
    sql = (await import("@/db/client")).sql;
    svc = await import("@/lib/prospects/service");
    fu = await import("@/lib/prospects/followups");
    rh = await import("@/lib/prospects/report-handoff");
    m = {
      sql, svc,
      projectSvc: await import("@/lib/projects/service"), setSvc: await import("@/lib/prompts/set-service"),
      promptSvc: await import("@/lib/prompts/prompt-service"), runSvc: await import("@/lib/runs/service"),
      execute: await import("@/lib/runs/execute"), jobs: await import("@/db/jobs"),
      companySvc: await import("@/lib/companies/service"), claims: await import("@/lib/claims/service"),
      parsing: await import("@/lib/parsing/service"), scoring: await import("@/lib/scoring/compute"),
      exclusivity: await import("@/lib/exclusivity/service"),
    };
    await sql.unsafe("drop schema public cascade; create schema public;");
    execSync(`npx tsx scripts/migrate.ts up --db "${TEST_URL}"`, { cwd: ROOT, stdio: "pipe" });
    await seedTestActors(sql);
  });
  afterAll(async () => { await sql.end(); });

  beforeEach(async () => {
    executeCapability.mockReset();
    delete process.env.REPORT_HANDOFF_AUTOSEND;
    await sql.unsafe(
      `truncate audit_log, jobs, suppression_entries, prospect_report_qa_runs, prospect_report_handoffs, prospect_replies, outreach_email_opens,
       prospect_outreach_sends, outreach_followup_sequences, outreach_drafts, prospect_activities, prospect_stage_history, screen_recording_plans,
       prospect_contacts, prospect_audit_views, prospect_audit_links, prospect_audits, audit_sense_checks, prospect_findings, prospect_benchmarks,
       prospect_authority_signals, realtrends_records, prospects, market_launches, exclusivity_checks, exclusivity_scopes,
       exclusivity_agreements, markets, connector_connections, claims, competitors, scores, sources, response_parses,
       mentions, response_citations, brand_candidates, companies, responses, runs, prompt_set_versions, prompts, prompt_sets, projects, llm_calls cascade`
    );
    (await import("@/lib/ai/mock")).resetMockProvider();
    await sql`truncate outreach_sender_identity`;
    unwrap(await (await import("@/lib/outreach/sender-identity")).setSenderIdentity(admin, {
      senderName: "Francisco Zuluaga", companyName: "Recommended First", postalAddress: "123 Grand St, Jersey City, NJ 07302", replyToEmail: SENDER,
    }));
    const fixture = await seedApprovedFinding(m, operator, admin, { projectKind: "prospect" });
    prospectId = fixture.prospectId;
    PROSPECT_CO = fixture.prospectCompanyId;
    COMPETITOR_CO = fixture.subjectCompanyId;
    snapshot = {
      templateVersion: "competitive_mismatch_reply_v1", runId: fixture.runId, provider: "mock", answerCount: 64, modelCount: 1,
      capturedAt: "2026-08-30T00:00:00Z", completedAt: "2026-08-30T00:00:00Z", scopeCopy: "Reno buyer and seller questions", audiences: ["buyer", "seller"],
      prospect: { companyId: PROSPECT_CO, prospectId: null, name: "Rivera Team", recommendationCount: 7, productionSignalId: PROSPECT_RECORD_ID, productionSourceUrl: "https://rt.example", productionYear: 2025, productionValue: 47_200_000, productionDisplay: "$47.2M closed" },
      competitor: { companyId: COMPETITOR_CO, prospectId: null, name: "Lumina", recommendationCount: 14, productionSignalId: "c", productionSourceUrl: "https://rt.example", productionYear: 2025, productionValue: 29_400_000, productionDisplay: "$29.4M closed", productionRatio: 0.62, recommendationGap: 7 },
      metricType: "closed_volume", thresholds: MISMATCH_THRESHOLDS,
    };
    await sql`update markets set state_code = 'NV', name = 'Reno, NV' where id = ${fixture.marketId}`;
    await sql`insert into realtrends_records (id, fingerprint, dataset_name, entity_type, entity_name, city, state, volume_usd, production_year, source_sheet, source_row)
      values (${PROSPECT_RECORD_ID}, 'fp-kane', 'test', 'team', 'Rivera Team', 'Reno', 'NV', 47200000, 2025, 'Teams', 1)`;
    const contact = unwrap(await svc.addContact(operator, { prospectId, name: "Ryan Kane", email: RECIPIENT, isPrimary: true }));
    contactId = contact.contactId;
    await sql`update prospects set stage = 'contacted' where id = ${prospectId}`;
    const [draft] = await sql`
      insert into outreach_drafts (prospect_id, finding_id, channel, contact_id, version, subject, body, tone, cta, generated_by, prompt_version, evidence_snapshot, status, approved_by, approved_at, created_by, sent_recorded_at)
      values (${prospectId}, ${fixture.findingId}, 'email', ${contactId}, 1, 'Ryan - Reno', ${T1_BODY}, 'direct', 'send them?', 'system', 'competitive_mismatch_reply_v1', ${sql.json(snapshot as never)}, 'approved', ${operator.id}, now(), ${operator.id}, ${T1_SENT})
      returning id`;
    await sql`
      insert into prospect_outreach_sends (draft_id, prospect_id, channel, recipient_email, body_hash, business_purpose, gate_verdict, allowed, provider_message_id, sent_by, sent_at, gmail_thread_id)
      values (${draft!.id}, ${prospectId}, 'gmail', ${RECIPIENT}, 'h', 'test', '{}', true, 'gm-t1', ${operator.id}, ${T1_SENT}, 'thread-1')`;
    unwrap(await fu.enrollFollowupSequence(operator, { prospectId }));
    await sql`insert into connector_connections (project_id, provider, connection_name, external_account_id, status, granted_scopes, config, last_sync_at, created_by)
      values (null, 'gmail', 'platform', ${SENDER}, 'active', '{}', ${sql.json({ sendAsAddress: SENDER })}, now(), ${operator.id})`;
    executeCapability.mockImplementation(async (args: { capability: string }) =>
      args.capability === "email.search_messages"
        ? { ok: true, data: { messages: [{ id: "gm-yes", threadId: "thread-1", messageId: "<yes@kane>", from: `Ryan Kane <${RECIPIENT}>`, to: SENDER, subject: "Re: Ryan - Reno", date: "2026-09-03T20:00:00Z", labelIds: ["INBOX"], body: "Yes" }] } }
        : { ok: false, errorCode: "unsupported" }
    );
  });

  async function sayYes(): Promise<string> {
    const rec = unwrap(await svc.recordProspectReply(operator, { prospectId, contactId, bodyText: "Yes", gmailMessageId: "gm-yes", receivedAt: new Date("2026-09-03T20:00:00Z") }));
    return rec.replyId;
  }
  const NOON = new Date("2026-09-04T16:00:00Z");

  it("yes → report published over the frozen evidence → 3 QA passes → threaded reply scheduled → drained → sent + audit_sent", async () => {
    await sayYes();
    const r1 = await rh.processReportHandoffs(NOON, { caller: passingCaller });
    expect(r1.enqueued).toBe(1);
    const h = (await rh.handoffForProspect(prospectId))!;
    expect(h.status).toBe("scheduled");
    expect(h.auditId).toBeTruthy();
    const [audit] = await sql`select snapshot->'mismatch' as block from prospect_audits where id = ${h.auditId}`;
    const block = audit!.block as { competitor: { name: string; recommendationCount: number }; answerCount: number };
    expect(block.competitor.name).toBe("Lumina");
    expect(block.competitor.recommendationCount).toBe(14);
    expect(block.answerCount).toBe(64);
    const runs = await sql`select kind, passed, content_hash from prospect_report_qa_runs where handoff_id = ${h.id} order by created_at`;
    expect(runs.map((x) => [x.kind, x.passed])).toEqual([["deterministic", true], ["prospect_review", true], ["sense_check", true]]);
    expect(new Set(runs.map((x) => x.contentHash)).size).toBe(1);
    const [d] = await sql`select subject, body, reply_to_id, scheduled_send_at, prompt_version, status from outreach_drafts where id = ${h.draftId}`;
    expect(d!.promptVersion).toBe("mismatch_report_delivery_v1");
    expect(d!.subject).toBe("Re: Ryan - Reno");
    expect(d!.replyToId).toBe(h.replyId);
    expect(d!.body).toContain("Here it is: https://app.test.local/audit/rivera-team/");
    expect(d!.body).toContain("RealTrends has your team at $47.2M closed versus $29.4M closed for Lumina.");
    expect(d!.body).not.toMatch(/[—–]/);
    const slotMin = (new Date(d!.scheduledSendAt as Date).getTime() - NOON.getTime()) / 60_000;
    expect(slotMin).toBeGreaterThanOrEqual(4);
    expect(slotMin).toBeLessThanOrEqual(12);
    // Re-running does nothing new.
    const r2 = await rh.processReportHandoffs(NOON, { caller: passingCaller });
    expect(r2.enqueued).toBe(0);
    expect((await sql`select count(*)::int as n from outreach_drafts where reply_to_id = ${h.replyId}`)[0]!.n).toBe(1);
    // The existing dispatcher transmits it (reply_to gate path, mock channel).
    await sql`update outreach_drafts set scheduled_send_at = now() - interval '1 minute' where id = ${h.draftId}`;
    const sent = unwrap(await svc.sendProspectDraft(operator, { draftId: h.draftId!, channel: "mock", businessPurpose: "Deliver the report he asked for", unattended: true }));
    expect(sent.providerMessageId).toContain("mock-");
    const r3 = await rh.processReportHandoffs(NOON, { caller: passingCaller });
    expect(r3.sent).toBe(1);
    expect((await rh.handoffForProspect(prospectId))!.status).toBe("sent");
    const [p] = await sql`select stage from prospects where id = ${prospectId}`;
    expect(p!.stage).toBe("audit_sent");
    const view = (await fu.listFollowupSequences({ prospectId }))[0]!;
    expect(view.handoff?.reportState).toBe("SENT");
  });

  it("a blocking prospect-review concern parks the handoff with the reason and creates no draft", async () => {
    await sayYes();
    await rh.processReportHandoffs(NOON, { caller: blockingCaller });
    const h = (await rh.handoffForProspect(prospectId))!;
    expect(h.status).toBe("needs_review");
    expect(h.reason).toContain('verdict "fix"');
    expect(h.reason).toContain("Uses the word prompt");
    expect(h.draftId).toBeNull();
    expect(h.auditId).toBeTruthy(); // the report itself is generated and kept
    expect((await fu.listFollowupSequences({ prospectId }))[0]!.handoff?.reportState).toBe("NEEDS_REVIEW");
    // A failed LLM call is a failure row, never a pass.
    const failing: AgentCaller = async () => { throw new Error("provider down"); };
    await sql`truncate prospect_report_qa_runs, prospect_report_handoffs`;
    await rh.processReportHandoffs(NOON, { caller: failing });
    const h2 = (await rh.handoffForProspect(prospectId))!;
    expect(h2.status).toBe("needs_review");
    expect(h2.reason).toContain("did not complete");
    const runs = await sql`select kind, passed, error from prospect_report_qa_runs where handoff_id = ${h2.id} and kind <> 'deterministic'`;
    expect(runs.every((r) => r.passed === false && String(r.error).includes("provider down"))).toBe(true);
  });

  it("autosend off parks at qa_passed; a later unsubscribe stops before any send", async () => {
    process.env.REPORT_HANDOFF_AUTOSEND = "false";
    await sayYes();
    await rh.processReportHandoffs(NOON, { caller: passingCaller });
    let h = (await rh.handoffForProspect(prospectId))!;
    expect(h.status).toBe("qa_passed");
    expect(h.draftId).toBeNull();
    expect((await fu.listFollowupSequences({ prospectId }))[0]!.handoff?.reportState).toBe("READY_TO_SEND");
    delete process.env.REPORT_HANDOFF_AUTOSEND;
    unwrap(await svc.recordProspectReply(operator, { prospectId, contactId, bodyText: "Actually, please unsubscribe me.", gmailMessageId: "gm-no", receivedAt: new Date("2026-09-04T15:00:00Z") }));
    await rh.processReportHandoffs(NOON, { caller: passingCaller });
    h = (await rh.handoffForProspect(prospectId))!;
    expect(h.status).toBe("stopped");
    expect(h.reason).toContain("unsubscribe");
    expect(h.draftId).toBeNull();
  });
});
