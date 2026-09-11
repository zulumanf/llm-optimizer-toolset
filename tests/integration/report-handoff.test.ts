/**
 * Spec 129 + 137: a positive reply on a mismatch prospect walks the
 * autonomous fulfillment lane — autonomy classification, evidence release
 * verification, the published private report, the fact manifest, artifact
 * assertions, ONE adversarial review, the release policy, a durable send
 * intent — or parks with a deterministic reason. The reviewer is stubbed at
 * the caller boundary; the report is published through the real
 * publishAudit; Gmail is mocked at the connector boundary.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
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
// Spec 138: the video lane's binaries (ffmpeg, ffprobe, Chromium) are mocked
// per test; preparation must see them as available on every CI box.
vi.mock("@/lib/video/render", async (orig) => ({ ...(await orig<typeof import("@/lib/video/render")>()), rendererAvailability: async () => ({ available: true, detail: "mocked" }) }));
vi.mock("@/lib/prospects/evidence-release", async (orig) => {
  // Spec 136: the release layer re-verifies against a real frozen run; this
  // suite's snapshot names a fixture run, so the run/production/count checks
  // are stubbed verified while the entity checks stay REAL (the resolver is
  // what several cases here assert on). tests/integration/evidence-release.test.ts
  // exercises the unstubbed layer.
  const real = await orig<typeof import("@/lib/prospects/evidence-release")>();
  const { countClaimEntityGate } = await import("@/lib/prospects/entity-aliases");
  const { latestEvidenceCorrection } = await import("@/lib/prospects/evidence-corrections");
  const verdictFor = async (s: MismatchEvidenceSnapshot, ctx?: { prospectId: string; sendId: string | null }) => {
    const g = await countClaimEntityGate({ prospect: s.prospect, competitor: s.competitor });
    const checks = g.statuses.map((st, i) => ({
      name: i === 0 ? "PROSPECT_ENTITY_VERIFIED" : "COMPETITOR_ENTITY_VERIFIED",
      passed: st.verified, detail: st.reason,
      reason: st.verified ? null : i === 0 ? "PROSPECT_ENTITY_UNVERIFIED" : "COMPETITOR_ENTITY_UNVERIFIED",
    }));
    // Mirror of the real integrity check: a correction in force whose counts
    // differ from the claim is PENDING_CORRECTION.
    const corr = ctx ? await latestEvidenceCorrection(ctx.prospectId, ctx.sendId) : null;
    const pending = corr !== null && (corr.correctedSnapshot.prospect.recommendationCount !== s.prospect.recommendationCount || corr.correctedSnapshot.competitor.recommendationCount !== s.competitor.recommendationCount);
    checks.push({ name: "NO_PENDING_CORRECTION", passed: !pending, detail: pending ? "correction in force" : "no correction", reason: pending ? "PENDING_CORRECTION" : null });
    const reasons = checks.filter((c) => !c.passed).map((c) => c.reason);
    return {
      version: real.EVIDENCE_RELEASE_VERSION, verified: reasons.length === 0, reasons, checks,
      diagnostics: {
        runId: s.runId, provider: s.provider, expectedCells: s.answerCount, validCells: s.answerCount, errorCells: 0, otherProviderCells: 0,
        stated: { prospect: s.prospect.recommendationCount, competitor: s.competitor.recommendationCount, denominator: s.answerCount },
        primary: { prospect: s.prospect.recommendationCount, competitor: s.competitor.recommendationCount, denominator: s.answerCount },
        shadow: { prospect: s.prospect.recommendationCount, competitor: s.competitor.recommendationCount, denominator: s.answerCount },
        coverageGaps: { prospect: 0, competitor: 0 },
        entityLevels: { prospect: g.statuses[0]?.level ?? null, competitor: g.statuses[1]?.level ?? null },
        productionRecords: { prospect: s.prospect.productionSignalId, competitor: s.competitor.productionSignalId },
        parserVersions: [], correctionId: corr?.id ?? null,
      },
    };
  };
  return {
    ...real,
    verifyEvidenceRelease: verdictFor,
    verifyDraftEvidenceRelease: async (db: unknown, draft: { id: string; prospectId: string; sequenceId: string | null }) => {
      const found = await real.evidenceSnapshotForDraft(db as never, draft.id);
      if (!found) return null;
      const [seq] = draft.sequenceId ? await (db as typeof import("@/db/client")["sql"])`select touch1_send_id from outreach_followup_sequences where id = ${draft.sequenceId}` : [];
      return verdictFor(found.snapshot, { prospectId: draft.prospectId, sendId: (seq?.touch1SendId as string | null) ?? null });
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

const passingCaller: AgentCaller = async () => ({
  text: JSON.stringify({ verdict: "PASS", reasons: [], confidence: 0.85, confidenceNote: "Full email and report supplied." }),
  tokensIn: 10, tokensOut: 10,
});
const blockingCaller: AgentCaller = async () => ({
  text: JSON.stringify({ verdict: "BLOCK", reasons: [{ code: "methodology", detail: "Calls the test a ranking.", quote: "ranked" }], confidence: 0.9, confidenceNote: "n/a" }),
  tokensIn: 10, tokensOut: 10,
});
const LANE_ENV = ["AUTONOMOUS_POSITIVE_REPLY_MODE", "AUTONOMOUS_POSITIVE_REPLY_CANARY_PERCENT", "AUTONOMOUS_POSITIVE_REPLY_KILL_SWITCH", "REPORT_HANDOFF_AUTOSEND", "FULFILLMENT_RELEASE_POLICY"] as const;
/** Most cases exercise the report-only path explicitly; the code default is
 * report_and_video (spec 139), covered by its own cases below. */
const lane = (mode?: string, extra: Record<string, string> = {}): void => {
  for (const k of LANE_ENV) delete process.env[k];
  process.env.FULFILLMENT_RELEASE_POLICY = "report_only";
  if (mode) process.env.AUTONOMOUS_POSITIVE_REPLY_MODE = mode;
  Object.assign(process.env, extra);
};
/** A releasable video walkthrough as the video lane (spec 138) records one:
 * stage release_ready / status ready, bound to the manifest, with passed
 * script, semantic and artifact QA rows on its hashes. */
async function fakeReleasableVideo(db: (typeof import("@/db/client"))["sql"], handoffId: string, manifestId: string): Promise<string> {
  const meta = { scriptHash: "script-sha", render: { sha256: "render-sha" }, timestamps: {} };
  const [existing] = await db`select id from prospect_fulfillment_artifacts where handoff_id = ${handoffId} and kind = 'video_walkthrough' order by revision desc limit 1`;
  const [row] = existing
    ? await db`update prospect_fulfillment_artifacts set status = 'ready', stage = 'release_ready', manifest_id = ${manifestId}, content_hash = 'render-sha', meta = meta || ${db.json(meta as never)}, updated_at = now() where id = ${existing.id} returning id`
    : await db`insert into prospect_fulfillment_artifacts (handoff_id, prospect_id, kind, revision, manifest_id, template_version, content_hash, status, stage, generation_key, meta)
      select ${handoffId}, h.prospect_id, 'video_walkthrough', 1, ${manifestId}, 'video-template-v1', 'render-sha', 'ready', 'release_ready', 'gen-1', ${db.json(meta as never)}
      from prospect_report_handoffs h where h.id = ${handoffId} returning id`;
  for (const [kind, hash] of [["video_script_qa", "script-sha"], ["video_semantic_review", "script-sha"], ["video_artifact_qa", "render-sha"]] as const) {
    await db`insert into prospect_report_qa_runs (handoff_id, kind, content_hash, passed, output) values (${handoffId}, ${kind}, ${hash}, true, '{}')`;
  }
  return row!.id as string;
}

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
    lane();
    await sql.unsafe(
      `truncate audit_log, jobs, suppression_entries, prospect_report_qa_runs, prospect_report_handoffs, prospect_replies, outreach_email_opens,
       prospect_outreach_sends, prospect_fulfillment_artifacts, prospect_fact_manifests, outreach_followup_sequences, outreach_drafts, prospect_activities, prospect_stage_history, screen_recording_plans,
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
    await sql`insert into realtrends_records (id, fingerprint, dataset_name, entity_type, entity_name, city, state, volume_usd, production_year, source_sheet, source_row,
        team_lead, company_id, match_status, matched_at)
      values (${PROSPECT_RECORD_ID}, 'fp-kane', 'test', 'team', 'Rivera Team', 'Reno', 'NV', 47200000, 2025, 'Teams', 1, 'Ryan Kane', ${PROSPECT_CO}, 'confirmed', now())`;
    {
      const ea = await import("@/lib/prospects/entity-aliases");
      await ea.applyVerifiedAliases(operator, PROSPECT_CO);
      await ea.recordEntityVerification(operator, { companyId: COMPETITOR_CO, level: "team", sourceUrl: "https://lumina.example/team" });
    }
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

  it("yes → autonomy eligible → evidence verified → report published → manifest + assertions → review → release → send intent → drained → sent + audit_sent", async () => {
    lane("NARROW_AUTONOMOUS");
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
    expect(runs.filter((x) => !String(x.kind).startsWith("video_")).map((x) => [x.kind, x.passed])).toEqual([["release_gate", true], ["deterministic", true], ["manifest_assertion", true], ["release_review", true]]);
    expect(h.autonomyClass).toBe("autonomy_eligible");
    expect(h.autoVerdict).toBe("transmit");
    expect(h.laneMode).toBe("NARROW_AUTONOMOUS");
    // ONE canonical manifest; the report and the email are artifacts of it.
    const [mf] = await sql`select id, manifest::text as manifest_text from prospect_fact_manifests where id = ${h.manifestId}`;
    const facts = (JSON.parse(mf!.manifestText as string) as { facts: Record<string, { display: string; value: unknown }> }).facts;
    expect(facts.FACT_COMPETITOR_RECOMMENDATIONS!.value).toBe(14);
    expect(facts.FACT_DENOMINATOR!.value).toBe(64);
    expect(facts.FACT_RECOMMENDATION_MULTIPLE!.display).toBe("2x as often");
    expect(facts.FACT_PRODUCTION_RATIO!.display).toBe("roughly 62%");
    const arts = await sql`select kind, revision, status, manifest_id from prospect_fulfillment_artifacts where handoff_id = ${h.id} and kind in ('private_report', 'positive_reply_email') order by kind`;
    expect(arts.map((a) => [a.kind, Number(a.revision), a.status, a.manifestId === h.manifestId])).toEqual([["positive_reply_email", 1, "ready", true], ["private_report", 1, "ready", true]]);
    const [d] = await sql`select subject, body, reply_to_id, scheduled_send_at, prompt_version, status, send_intent_key, send_message_id from outreach_drafts where id = ${h.draftId}`;
    expect(d!.promptVersion).toBe("mismatch_report_delivery_v2");
    expect(d!.subject).toBe("Re: Ryan - Reno");
    expect(d!.replyToId).toBe(h.replyId);
    expect(d!.sendIntentKey).toMatch(/^[0-9a-f]{64}$/);
    expect(d!.sendMessageId).toMatch(/^<rf-[0-9a-f]{32}@recommendedfirst\.com>$/);
    // Spec 134: the delivered link is the private-report invitation.
    expect(d!.body).toContain("\nhttps://app.test.local/report/rivera-team/");
    expect(d!.body).toContain("The biggest thing that stood out: Lumina closed roughly 62% of your team's volume, but was recommended 2x as often in the same 64-answer test.");
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
    expect((await sql`select status from prospect_fulfillment_artifacts where handoff_id = ${h.id} and kind in ('private_report', 'positive_reply_email')`).every((a) => a.status === "sent")).toBe(true);
    // 17: everything behind the action is reconstructable from the ledgers.
    const { reconstructFulfillment } = await import("@/lib/prospects/fulfillment-lane");
    const rec = (await reconstructFulfillment(h.id))!;
    expect(rec.reply).toMatchObject({ classification: "positive_interest", gmailMessageId: "gm-yes" });
    const qaRuns = rec.qaRuns as { kind: string }[];
    expect(qaRuns.filter((q) => !q.kind.startsWith("video_")).length).toBe(4);
    expect(qaRuns.some((q) => q.kind === "video_script_qa")).toBe(true); // spec 138: the video's script QA rides the same ledger
    expect((rec.sends as { providerMessageId: string }[])[0]!.providerMessageId).toContain("mock-");
    expect(JSON.stringify(rec)).not.toMatch(/api[_-]?key|refresh_token|access_token/i);
    const [p] = await sql`select stage from prospects where id = ${prospectId}`;
    expect(p!.stage).toBe("audit_sent");
    const view = (await fu.listFollowupSequences({ prospectId }))[0]!;
    expect(view.handoff?.reportState).toBe("SENT");
  });

  it("a BLOCK from the adversarial reviewer parks the handoff with the quoted reason; the staged draft cannot transmit", async () => {
    lane("NARROW_AUTONOMOUS");
    await sayYes();
    await rh.processReportHandoffs(NOON, { caller: blockingCaller });
    const h = (await rh.handoffForProspect(prospectId))!;
    expect(h.status).toBe("needs_review");
    expect(h.reason).toContain("RELEASE_BLOCKED: semantic review: [methodology] Calls the test a ranking.");
    expect(h.auditId).toBeTruthy(); // the report itself is generated and kept
    expect(h.draftId).toBeTruthy(); // staged before review — approved, unscheduled
    const [d] = await sql`select scheduled_send_at from outreach_drafts where id = ${h.draftId}`;
    expect(d!.scheduledSendAt).toBeNull();
    const refused = await svc.sendProspectDraft(operator, { draftId: h.draftId!, channel: "mock", businessPurpose: "Deliver the report he asked for" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toMatch(/handoff is needs_review/);
    expect((await fu.listFollowupSequences({ prospectId }))[0]!.handoff?.reportState).toBe("NEEDS_REVIEW");
    // A failed LLM call is a failure row, never a pass.
    const failing: AgentCaller = async () => { throw new Error("provider down"); };
    await sql`truncate prospect_report_qa_runs, prospect_fulfillment_artifacts, prospect_fact_manifests, prospect_report_handoffs cascade`;
    await rh.processReportHandoffs(NOON, { caller: failing });
    const h2 = (await rh.handoffForProspect(prospectId))!;
    expect(h2.status).toBe("needs_review");
    expect(h2.reason).toContain("reviewer unavailable: provider down");
    const runs = await sql`select kind, passed, error from prospect_report_qa_runs where handoff_id = ${h2.id} and kind = 'release_review'`;
    expect(runs.length).toBe(1);
    expect(runs.every((r) => r.passed === false && String(r.error).includes("provider down"))).toBe(true);
  });

  it("a hand-recorded yes with NO sequence still gets a handoff, an owner and a due date; the default lane (SHADOW) prepares everything and holds", async () => {
    // Operating review 2026-09-07: both real positive replies had failed the
    // old preconditions (Gmail-ingested + enrolled sequence).
    await sql`delete from outreach_followup_sequences where prospect_id = ${prospectId}`;
    const rec = unwrap(await svc.recordProspectReply(operator, { prospectId, contactId, bodyText: "Yes, send it over", receivedAt: new Date("2026-09-03T20:00:00Z") }));
    const [p] = await sql`select owner_id, next_action, next_action_on::text from prospects where id = ${prospectId}`;
    expect(p!.ownerId).not.toBeNull();
    expect(p!.nextAction).toMatch(/positive reply/);
    expect(p!.nextActionOn).toBe("2026-09-04");
    const pr = await import("@/lib/prospects/positive-replies");
    expect((await pr.positiveRepliesWaiting(NOON)).map((w) => w.replyId)).toContain(rec.replyId);
    const r1 = await rh.processReportHandoffs(NOON, { caller: passingCaller });
    expect(r1.enqueued).toBe(1);
    const h = (await rh.handoffForProspect(prospectId))!;
    expect(h.sequenceId).toBeNull();
    expect(h.status).toBe("release_ready");
    expect(h.autoVerdict).toBe("would_send");
    expect(h.laneMode).toBe("SHADOW");
    expect(h.reason).toContain("SHADOW: all gates passed; would have sent");
    expect(h.draftId).toBeTruthy();
    const [d] = await sql`select scheduled_send_at, status from outreach_drafts where id = ${h.draftId}`;
    expect(d).toMatchObject({ scheduledSendAt: null, status: "approved" });
    expect((await sql`select count(*)::int as n from prospect_outreach_sends where prospect_id = ${prospectId} and sent_at > '2026-09-03'`)[0]!.n).toBe(0);
    // Today shows the lane's verdict and the next action.
    const w = (await pr.positiveRepliesWaiting(NOON)).find((x) => x.replyId === rec.replyId)!;
    expect(w.lane?.state).toBe("RELEASE_READY_SHADOW_HELD");
    expect(w.lane?.nextAction).toMatch(/SHADOW/);
    // Further passes create nothing new (28) and never time a held handoff out.
    const r2 = await rh.processReportHandoffs(NOON, { caller: passingCaller });
    expect(r2.enqueued).toBe(0);
    expect(r2.held).toBe(1);
    for (let i = 0; i < 4; i++) await rh.processReportHandoffs(new Date(NOON.getTime() + (i + 1) * 3_600_000), { caller: passingCaller });
    const held = (await rh.handoffForProspect(prospectId))!;
    expect(held.status).toBe("release_ready");
    expect(held.attempts).toBeLessThanOrEqual(3);
    expect((await sql`select count(*)::int as n from outreach_drafts where reply_to_id = ${rec.replyId}`)[0]!.n).toBe(1);
    expect((await sql`select count(*)::int as n from prospect_fulfillment_artifacts where handoff_id = ${h.id} and kind in ('private_report', 'positive_reply_email')`)[0]!.n).toBe(2);
    // The founder may still send the staged reply by hand (recorded through
    // the same gate; a hand-recorded reply has no Gmail thread to reply into).
    unwrap(await svc.sendProspectDraft(operator, { draftId: h.draftId!, channel: "manual", businessPurpose: "Deliver the report he asked for" }));
    expect((await sql`select count(*)::int as n from prospect_outreach_sends where draft_id = ${h.draftId} and allowed`)[0]!.n).toBe(1);
    unwrap(await pr.resolvePositiveReply(operator, { prospectId, replyId: rec.replyId, outcome: "Report sent by hand; offer stated." }));
    expect((await pr.positiveRepliesWaiting(NOON)).map((w) => w.replyId)).not.toContain(rec.replyId);
  });

  it("an unverified entity parks the hand-off at needs_review before any report or reply exists (fail closed, spec 136)", async () => {
    lane("NARROW_AUTONOMOUS");
    await sql`update companies set aliases = '{}' where id = ${PROSPECT_CO}`;
    await sayYes();
    await rh.processReportHandoffs(NOON, { caller: passingCaller });
    const h = (await rh.handoffForProspect(prospectId))!;
    // Spec 136: the report's evidence goes through the release layer inside
    // the deterministic QA pass — the hand-off never reaches "scheduled", so
    // no delivery draft exists for the send gate to refuse.
    expect(h.status).toBe("needs_review");
    expect(h.draftId).toBeNull();
    expect(h.auditId).toBeNull();
    expect(h.manifestId).toBeNull();
    expect(JSON.stringify(h)).toContain("EVIDENCE_RELEASE_BLOCKED");
    expect(JSON.stringify(h)).toContain("PROSPECT_ENTITY_UNVERIFIED");
    // The send gate itself still refuses a count-stating draft for the
    // unverified entity (belt and braces): a hand-built delivery draft
    // carrying the frozen evidence is ledgered as refused.
    const [t1] = await sql`select id, finding_id, contact_id from outreach_drafts where prospect_id = ${prospectId} and evidence_snapshot is not null order by created_at asc limit 1`;
    const [d] = await sql`
      insert into outreach_drafts (prospect_id, finding_id, channel, contact_id, parent_id, version, subject, body, generated_by, status, approved_by, approved_at, created_by)
      values (${prospectId}, ${t1!.findingId}, 'email', ${t1!.contactId}, ${t1!.id}, 2, 'Re: Ryan - Reno', ${'Ryan,\n\nThe report is ready.\n\n123 Grand St, Jersey City, NJ 07302\nIf you\'d rather not hear from us, reply "unsubscribe" and we will not contact you again.'}, 'operator', 'approved', ${operator.id}, now(), ${operator.id})
      returning id
    `;
    const res = await svc.sendProspectDraft(operator, { draftId: d!.id as string, channel: "mock", businessPurpose: "Deliver the report he asked for" });
    expect(res.ok).toBe(false);
    const [ledger] = await sql`select allowed, gate_verdict from prospect_outreach_sends where draft_id = ${d!.id} order by sent_at desc limit 1`;
    expect(ledger!.allowed).toBe(false);
    expect(JSON.stringify(ledger!.gateVerdict)).toContain("ENTITY_RESOLUTION_UNVERIFIED");
    // The same draft transmits once the entity is verified again.
    const ea = await import("@/lib/prospects/entity-aliases");
    await ea.applyVerifiedAliases(operator, PROSPECT_CO);
    const again = unwrap(await svc.sendProspectDraft(operator, { draftId: d!.id as string, channel: "mock", businessPurpose: "Deliver the report he asked for" }));
    expect(again.providerMessageId).toContain("mock-");
  });

  it("the kill switch holds in every mode; a later unsubscribe stops a held handoff and its staged draft can never transmit (32)", async () => {
    lane("NARROW_AUTONOMOUS", { AUTONOMOUS_POSITIVE_REPLY_KILL_SWITCH: "true" });
    await sayYes();
    await rh.processReportHandoffs(NOON, { caller: passingCaller });
    let h = (await rh.handoffForProspect(prospectId))!;
    expect(h.status).toBe("release_ready");
    expect(h.autoVerdict).toBe("would_send");
    expect(h.reason).toContain("kill switch");
    expect((await fu.listFollowupSequences({ prospectId }))[0]!.handoff?.reportState).toBe("READY_TO_SEND");
    unwrap(await svc.recordProspectReply(operator, { prospectId, contactId, bodyText: "Actually, please unsubscribe me.", gmailMessageId: "gm-no", receivedAt: new Date("2026-09-04T15:00:00Z") }));
    await rh.processReportHandoffs(NOON, { caller: passingCaller });
    h = (await rh.handoffForProspect(prospectId))!;
    expect(h.status).toBe("stopped");
    expect(h.reason).toContain("unsubscribe");
    const refused = await svc.sendProspectDraft(operator, { draftId: h.draftId!, channel: "mock", businessPurpose: "Deliver the report he asked for" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toMatch(/suppressed|handoff is stopped/);
    expect((await sql`select count(*)::int as n from prospect_outreach_sends where draft_id = ${h.draftId} and allowed`)[0]!.n).toBe(0);
  });

  it("complex replies always escalate (20): 'Yes, how much?' parks immediately with no report, no draft; founder reactivation re-enters at the eligibility check (31)", async () => {
    lane("NARROW_AUTONOMOUS");
    unwrap(await svc.recordProspectReply(operator, { prospectId, contactId, bodyText: "Yes, how much?", gmailMessageId: "gm-price", receivedAt: new Date("2026-09-03T20:00:00Z") }));
    await rh.processReportHandoffs(NOON, { caller: passingCaller });
    let h = (await rh.handoffForProspect(prospectId))!;
    expect(h.status).toBe("needs_review");
    expect(h.autonomyClass).toBe("escalate");
    expect(h.autoVerdict).toBe("escalated");
    expect(h.reason).toMatch(/^ESCALATED_TO_FOUNDER: (pricing or cost language|question in the reply)/);
    expect(h.auditId).toBeNull();
    expect(h.draftId).toBeNull();
    const w = (await (await import("@/lib/prospects/positive-replies")).positiveRepliesWaiting(NOON)).find((x) => x.prospectId === prospectId)!;
    expect(w.lane).toMatchObject({ state: "ESCALATED_TO_FOUNDER", reportStatus: "not published" });
    expect(w.lane!.whyStopped).toContain("ESCALATED_TO_FOUNDER");
    // Repeated ticks never move an escalated handoff (30/31).
    await rh.processReportHandoffs(NOON, { caller: passingCaller });
    expect((await rh.handoffForProspect(prospectId))!.status).toBe("needs_review");
    // Explicit founder reactivation is the only way back in — and it lands at
    // the eligibility check, never past the gates.
    const { reactivateHandoff, assertTransition } = await import("@/lib/prospects/fulfillment-lane");
    expect(() => assertTransition("needs_review", "scheduled")).toThrow(/Invalid fulfillment transition/);
    await reactivateHandoff(admin, h.id, "Spoke to Ryan; he just wants the report.");
    h = (await rh.handoffForProspect(prospectId))!;
    expect(h.status).toBe("autonomy_eligible");
    await rh.processReportHandoffs(NOON, { caller: passingCaller });
    h = (await rh.handoffForProspect(prospectId))!;
    expect(h.status).toBe("scheduled");
  });

  it("a founder may accept the reviewer's concerns (audited) but never an evidence block; the next pass proceeds without re-asking the model", async () => {
    lane("NARROW_AUTONOMOUS");
    await sayYes();
    await rh.processReportHandoffs(NOON, { caller: blockingCaller });
    let h = (await rh.handoffForProspect(prospectId))!;
    expect(h.status).toBe("needs_review");
    const { reactivateHandoff } = await import("@/lib/prospects/fulfillment-lane");
    await reactivateHandoff(admin, h.id, "Founder: the copy is mine; the reviewer over-read it.", { acceptReviewConcerns: true });
    let asked = 0;
    const counting: AgentCaller = async (...a) => { asked += 1; return blockingCaller(...a); };
    await rh.processReportHandoffs(NOON, { caller: counting });
    h = (await rh.handoffForProspect(prospectId))!;
    expect(h.status).toBe("scheduled");
    expect(asked).toBe(0);
    const [run] = await sql`select passed, agent_version, output from prospect_report_qa_runs where handoff_id = ${h.id} and kind = 'release_review' order by created_at desc limit 1`;
    expect(run).toMatchObject({ passed: true });
    expect(run!.agentVersion).toMatch(/^founder-accepted:fulfillment-release-review-v\d+$/);
    // An evidence block cannot be accepted away.
    await sql`truncate prospect_report_qa_runs, prospect_fulfillment_artifacts, prospect_fact_manifests, prospect_report_handoffs cascade`;
    await sql`update companies set aliases = '{}' where id = ${PROSPECT_CO}`;
    await rh.processReportHandoffs(NOON, { caller: passingCaller });
    const blocked = (await rh.handoffForProspect(prospectId))!;
    expect(blocked.reason).toContain("EVIDENCE_RELEASE_BLOCKED");
    await expect(reactivateHandoff(admin, blocked.id, "try", { acceptReviewConcerns: true })).rejects.toThrow(/Only a semantic-review block can be accepted/);
  });

  it("spec 139: report_and_video holds at qa_passed (WAITING_FOR_VIDEO); the staged email never promises a walkthrough; a held draft cannot transmit", async () => {
    lane("NARROW_AUTONOMOUS", { FULFILLMENT_RELEASE_POLICY: "report_and_video" });
    await sayYes();
    await rh.processReportHandoffs(NOON, { caller: passingCaller });
    const h = (await rh.handoffForProspect(prospectId))!;
    expect(h.status).toBe("qa_passed");
    expect(h.reason).toMatch(/^WAITING_FOR_VIDEO/);
    expect(h.autoVerdict).toBe("held");
    const [d] = await sql`select body, scheduled_send_at from outreach_drafts where id = ${h.draftId}`;
    expect(d!.body).not.toMatch(/walkthrough/i);
    expect(d!.scheduledSendAt).toBeNull();
    // 13: even a founder hand-send of the held draft is refused at the gate.
    const refused = await svc.sendProspectDraft(operator, { draftId: h.draftId!, channel: "mock", businessPurpose: "Deliver the report she asked for" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toMatch(/handoff is qa_passed/);
    // Repeated ticks hold; nothing is sent.
    await rh.processReportHandoffs(NOON, { caller: passingCaller });
    expect((await rh.handoffForProspect(prospectId))!.status).toBe("qa_passed");
    expect((await sql`select count(*)::int as n from prospect_outreach_sends where prospect_id = ${prospectId} and allowed and sent_at > '2026-09-03'`)[0]!.n).toBe(0);
    // A release_ready handoff that predates the policy steps back to the hold.
    lane("SHADOW", { FULFILLMENT_RELEASE_POLICY: "report_only" });
    await sql`update prospect_report_handoffs set status = 'release_ready', auto_verdict = 'would_send', updated_at = now() - interval '1 hour' where id = ${h.id}`;
    lane("SHADOW", { FULFILLMENT_RELEASE_POLICY: "report_and_video" });
    await rh.processReportHandoffs(NOON, { caller: passingCaller });
    expect((await rh.handoffForProspect(prospectId))!).toMatchObject({ status: "qa_passed" });
  });

  it("spec 139: a releasable video re-stages the email as the video variant (old draft superseded, reviewer re-run) and STAGES for founder review under SHADOW — no send (18/19)", { timeout: 30_000 }, async () => {
    lane("SHADOW", { FULFILLMENT_RELEASE_POLICY: "report_and_video" });
    await sayYes();
    await rh.processReportHandoffs(NOON, { caller: passingCaller });
    let h = (await rh.handoffForProspect(prospectId))!;
    expect(h.status).toBe("qa_passed");
    const reportOnlyDraft = h.draftId!;
    await fakeReleasableVideo(sql, h.id, h.manifestId!);
    let reviews = 0;
    const counting: AgentCaller = async (...a) => { reviews += 1; return passingCaller(...a); };
    await rh.processReportHandoffs(NOON, { caller: counting });
    h = (await rh.handoffForProspect(prospectId))!;
    expect(h.status).toBe("release_ready");
    expect(h.autoVerdict).toBe("would_send");
    expect(reviews).toBe(1);
    expect(h.draftId).not.toBe(reportOnlyDraft);
    const [video] = await sql`select body, scheduled_send_at, status from outreach_drafts where id = ${h.draftId}`;
    expect(video!.body).toContain("I put together a quick walkthrough along with the exact questions and side-by-side results here:");
    expect(video!.scheduledSendAt).toBeNull();
    expect(video!.status).toBe("approved");
    const [old] = await sql`select status from outreach_drafts where id = ${reportOnlyDraft}`;
    expect(old!.status).toBe("superseded");
    expect((await sql`select count(*)::int as n from outreach_drafts where reply_to_id = ${h.replyId}`)[0]!.n).toBe(2);
    expect((await sql`select count(*)::int as n from prospect_outreach_sends where prospect_id = ${prospectId} and allowed and sent_at > '2026-09-03'`)[0]!.n).toBe(0);
    // 16: the same manifest backs report, email and video.
    const arts = await sql`select kind, manifest_id from prospect_fulfillment_artifacts where handoff_id = ${h.id} and status <> 'superseded'`;
    expect(new Set(arts.map((a) => a.manifestId)).size).toBe(1);
    // Ticks after that: still held for the founder, still one video draft.
    await rh.processReportHandoffs(new Date(NOON.getTime() + 3_600_000), { caller: counting });
    expect((await rh.handoffForProspect(prospectId))!.status).toBe("release_ready");
    expect(reviews).toBe(1);
  });

  it("spec 139: a founder acceptance is bound to the artifact it accepted — a revised report is reviewed again", async () => {
    lane("NARROW_AUTONOMOUS");
    await sayYes();
    await rh.processReportHandoffs(NOON, { caller: blockingCaller });
    const h = (await rh.handoffForProspect(prospectId))!;
    expect(h.status).toBe("needs_review");
    const { reactivateHandoff } = await import("@/lib/prospects/fulfillment-lane");
    await reactivateHandoff(admin, h.id, "accepted", { acceptReviewConcerns: true });
    // The artifact under review changes before the next pass (here: the
    // email's greeting, derived from the delivered Touch 1) — a new hash.
    await sql`update prospects set business_name = 'Rivera Team (Reno)' where id = ${prospectId}`;
    let asked = 0;
    const counting: AgentCaller = async (...a) => { asked += 1; return blockingCaller(...a); };
    await rh.processReportHandoffs(NOON, { caller: counting });
    expect(asked).toBe(1);
    expect((await rh.handoffForProspect(prospectId))!.status).toBe("needs_review");
  });

  it("24: the same Gmail reply ingested twice — sequentially and concurrently — yields one reply row, one handoff, one draft", async () => {
    lane("NARROW_AUTONOMOUS");
    const a = unwrap(await svc.recordProspectReply(operator, { prospectId, contactId, bodyText: "Yes", gmailMessageId: "gm-dup", receivedAt: new Date("2026-09-03T20:00:00Z") }));
    const b = unwrap(await svc.recordProspectReply(operator, { prospectId, contactId, bodyText: "Yes", gmailMessageId: "gm-dup", receivedAt: new Date("2026-09-03T20:00:00Z") }));
    expect(b.replyId).toBe(a.replyId);
    const both = await Promise.allSettled([
      svc.recordProspectReply(operator, { prospectId, contactId, bodyText: "Yes", gmailMessageId: "gm-dup", receivedAt: new Date("2026-09-03T20:00:00Z") }),
      svc.recordProspectReply(operator, { prospectId, contactId, bodyText: "Yes", gmailMessageId: "gm-dup", receivedAt: new Date("2026-09-03T20:00:00Z") }),
    ]);
    expect(both.some((r) => r.status === "fulfilled")).toBe(true);
    expect((await sql`select count(*)::int as n from prospect_replies where gmail_message_id = 'gm-dup'`)[0]!.n).toBe(1);
    await rh.processReportHandoffs(NOON, { caller: passingCaller });
    await rh.processReportHandoffs(NOON, { caller: passingCaller });
    expect((await sql`select count(*)::int as n from prospect_report_handoffs where prospect_id = ${prospectId}`)[0]!.n).toBe(1);
    expect((await sql`select count(*)::int as n from outreach_drafts where reply_to_id = ${a.replyId}`)[0]!.n).toBe(1);
  });

  it("26/48: two workers advancing the same handoff concurrently produce one send intent, one artifact revision per kind (25)", async () => {
    lane("NARROW_AUTONOMOUS");
    await sayYes();
    await rh.enqueueReportHandoffs();
    const h0 = (await rh.handoffForProspect(prospectId))!;
    const results = await Promise.allSettled([
      rh.advanceReportHandoff(h0, NOON, { caller: passingCaller }),
      rh.advanceReportHandoff(h0, NOON, { caller: passingCaller }),
      rh.advanceReportHandoff(h0, NOON, { caller: passingCaller }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    const h = (await rh.handoffForProspect(prospectId))!;
    expect(h.status).toBe("scheduled");
    expect((await sql`select count(*)::int as n from outreach_drafts where reply_to_id = ${h.replyId}`)[0]!.n).toBe(1);
    expect((await sql`select count(*)::int as n from outreach_drafts where send_intent_key is not null and prospect_id = ${prospectId}`)[0]!.n).toBe(1);
    const arts = await sql`select kind, count(*)::int as n from prospect_fulfillment_artifacts where handoff_id = ${h.id} and status <> 'superseded' group by kind`;
    expect(arts.every((a) => a.n === 1)).toBe(true);
    // A worker retry after the send intent exists is a no-op on the outbox.
    await rh.processReportHandoffs(NOON, { caller: passingCaller });
    expect((await sql`select count(*)::int as n from outreach_drafts where reply_to_id = ${h.replyId}`)[0]!.n).toBe(1);
  });

  it("27: Gmail accepted the message but the worker died before the ledger commit — reconciliation by Message-ID records the send and never resends", async () => {
    lane("NARROW_AUTONOMOUS");
    await sayYes();
    await rh.processReportHandoffs(NOON, { caller: passingCaller });
    const h = (await rh.handoffForProspect(prospectId))!;
    expect(h.status).toBe("scheduled");
    const [d] = await sql`select send_message_id from outreach_drafts where id = ${h.draftId}`;
    const fingerprint = (d!.sendMessageId as string).replace(/^<|>$/g, "");
    // Simulate the crash: a claim older than the stale window, no ledger row.
    await sql`update outreach_drafts set send_claimed_at = now() - interval '30 minutes', send_attempts = 1, scheduled_send_at = now() - interval '1 minute' where id = ${h.draftId}`;
    const calls: string[] = [];
    executeCapability.mockImplementation(async (args: { capability: string; input: { q?: string } }) => {
      calls.push(args.capability);
      if (args.capability === "email.search_messages" && args.input.q === `rfc822msgid:${fingerprint}`) {
        return { ok: true, data: { messages: [{ id: "gm-sent-1", threadId: "thread-1", messageId: `<${fingerprint}>`, from: SENDER, to: RECIPIENT, subject: "Re: Ryan - Reno", date: "2026-09-04T16:05:00Z", labelIds: ["SENT"], body: "..." }] } };
      }
      return { ok: false, errorCode: "unsupported" };
    });
    const { drainScheduledSends } = await import("@/lib/prospects/scheduled-sends");
    const r = await drainScheduledSends();
    expect(r).toMatchObject({ reconciled: 1, sent: 0, parked: 0 });
    expect(calls).not.toContain("email.send_approved_message");
    const sends = await sql`select provider_message_id, reconciled_from, allowed, gmail_thread_id from prospect_outreach_sends where draft_id = ${h.draftId}`;
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ providerMessageId: "gm-sent-1", reconciledFrom: "gmail rfc822msgid search", allowed: true, gmailThreadId: "thread-1" });
    const [after] = await sql`select sent_recorded_at, send_claimed_at, scheduled_send_at from outreach_drafts where id = ${h.draftId}`;
    expect(after!.sentRecordedAt).not.toBeNull();
    expect(after!.sendClaimedAt).toBeNull();
    // Repeated ticks: no duplicate send (28); the handoff observes the ledger and completes.
    expect(await drainScheduledSends()).toMatchObject({ due: 0, sent: 0, reconciled: 0 });
    await rh.processReportHandoffs(NOON, { caller: passingCaller });
    expect((await rh.handoffForProspect(prospectId))!.status).toBe("sent");
    expect((await sql`select count(*)::int as n from prospect_outreach_sends where draft_id = ${h.draftId}`)[0]!.n).toBe(1);
  });

  it("27b: a stale claim whose fingerprint is NOT in the mailbox parks (no blind resend); a failed search parks too", async () => {
    lane("NARROW_AUTONOMOUS");
    await sayYes();
    await rh.processReportHandoffs(NOON, { caller: passingCaller });
    const h = (await rh.handoffForProspect(prospectId))!;
    await sql`update outreach_drafts set send_claimed_at = now() - interval '30 minutes', send_attempts = 1, scheduled_send_at = now() - interval '1 minute' where id = ${h.draftId}`;
    executeCapability.mockImplementation(async (args: { capability: string }) => (args.capability === "email.search_messages" ? { ok: true, data: { messages: [] } } : { ok: false, errorCode: "unsupported" }));
    const { drainScheduledSends } = await import("@/lib/prospects/scheduled-sends");
    expect(await drainScheduledSends()).toMatchObject({ reconciled: 0, sent: 0, parked: 1 });
    const [d] = await sql`select last_send_error, scheduled_send_at, sent_recorded_at from outreach_drafts where id = ${h.draftId}`;
    expect(d!.lastSendError).toContain("safe to reschedule");
    expect(d!.scheduledSendAt).toBeNull();
    expect(d!.sentRecordedAt).toBeNull();
    expect((await sql`select count(*)::int as n from prospect_outreach_sends where draft_id = ${h.draftId}`)[0]!.n).toBe(0);
    await rh.processReportHandoffs(NOON, { caller: passingCaller });
    expect((await rh.handoffForProspect(prospectId))!.status).toBe("needs_review");
  });

  it("23/46: a correction inserted after the artifacts were rendered blocks at send time, marks them stale and parks the handoff", async () => {
    lane("NARROW_AUTONOMOUS");
    await sayYes();
    await rh.processReportHandoffs(NOON, { caller: passingCaller });
    const h = (await rh.handoffForProspect(prospectId))!;
    expect(h.status).toBe("scheduled");
    // The correction ledger learns that Lumina was really recommended 29 times.
    const seq = (await fu.sequenceForProspect(prospectId))!;
    const [t1] = await sql`select id from outreach_drafts where prospect_id = ${prospectId} and evidence_snapshot is not null order by created_at asc limit 1`;
    const [run] = await sql`select id from runs limit 1`;
    const corrected = { ...snapshot, competitor: { ...snapshot.competitor, recommendationCount: 29 } };
    await sql`insert into outreach_evidence_corrections (prospect_id, evidence_draft_id, send_id, source_run_id, original_snapshot, corrected_snapshot, reason, corrected_by)
      values (${prospectId}, ${t1!.id}, ${seq.touch1SendId}, ${run!.id}, ${sql.json(snapshot as never)}, ${sql.json(corrected as never)}, 'competitor alias added', ${operator.id})`;
    await sql`update outreach_drafts set scheduled_send_at = now() - interval '1 minute' where id = ${h.draftId}`;
    const refused = await svc.sendProspectDraft(operator, { draftId: h.draftId!, channel: "mock", businessPurpose: "Deliver the report he asked for", unattended: true });
    expect(refused.ok).toBe(false);
    const [ledger] = await sql`select allowed, gate_verdict from prospect_outreach_sends where draft_id = ${h.draftId} order by sent_at desc limit 1`;
    expect(ledger!.allowed).toBe(false);
    const checks = (ledger!.gateVerdict as { checks: { name: string; passed: boolean; detail: string }[] }).checks;
    expect(checks.find((c) => c.name === "evidence_release_verified")).toMatchObject({ passed: false });
    expect(checks.find((c) => c.name === "fulfillment_manifest_current")!.detail).toContain("SEND_TIME_REVALIDATION_FAILED");
    const arts = await sql`select status, stale_reason from prospect_fulfillment_artifacts where handoff_id = ${h.id}`;
    expect(arts.every((a) => a.status === "stale")).toBe(true);
    await rh.processReportHandoffs(NOON, { caller: passingCaller });
    expect((await rh.handoffForProspect(prospectId))!.status).toBe("needs_review");
  });

  it("45: a suppression added between preparation and dispatch refuses at the gate; the handoff parks with the reason", async () => {
    lane("NARROW_AUTONOMOUS");
    await sayYes();
    await rh.processReportHandoffs(NOON, { caller: passingCaller });
    const h = (await rh.handoffForProspect(prospectId))!;
    expect(h.status).toBe("scheduled");
    const { suppress } = await import("@/lib/outreach/suppression");
    await sql.begin(async (tx) => { await suppress(tx, { scope: "email", value: RECIPIENT, reason: "opt_out", detail: "test", projectId: null, userId: operator.id }); });
    await sql`update outreach_drafts set scheduled_send_at = now() - interval '1 minute' where id = ${h.draftId}`;
    const { drainScheduledSends } = await import("@/lib/prospects/scheduled-sends");
    const r = await drainScheduledSends();
    expect(r).toMatchObject({ sent: 0, parked: 1 });
    expect((await sql`select count(*)::int as n from prospect_outreach_sends where draft_id = ${h.draftId} and allowed`)[0]!.n).toBe(0);
    // A suppressed recipient is terminal for the lane: no external response.
    await rh.processReportHandoffs(NOON, { caller: passingCaller });
    const after = (await rh.handoffForProspect(prospectId))!;
    expect(after.status).toBe("stopped");
    expect(after.reason).toMatch(/suppressed/i);
  });

  it("47: a market policy change (territory reserved) between preparation and dispatch refuses at the gate", async () => {
    lane("NARROW_AUTONOMOUS");
    await sayYes();
    await rh.processReportHandoffs(NOON, { caller: passingCaller });
    const h = (await rh.handoffForProspect(prospectId))!;
    expect(h.status).toBe("scheduled");
    const [market] = await sql`select id from markets limit 1`;
    const [project] = await sql`select id from projects order by created_at asc limit 1`;
    unwrap(await m.exclusivity.createAgreement(operator, { projectId: project!.id as string, startsOn: new Date().toISOString().slice(0, 10), status: "reserved", scopes: [{ marketId: market!.id as string, serviceCategory: null, segment: null }] }));
    const refused = await svc.sendProspectDraft(operator, { draftId: h.draftId!, channel: "mock", businessPurpose: "Deliver the report he asked for", unattended: true });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toMatch(/Territory conflict/);
  });

  it("CANARY is a deterministic percentage: 100% transmits, 0% holds as would_send", async () => {
    lane("CANARY", { AUTONOMOUS_POSITIVE_REPLY_CANARY_PERCENT: "100" });
    await sayYes();
    await rh.processReportHandoffs(NOON, { caller: passingCaller });
    expect((await rh.handoffForProspect(prospectId))!).toMatchObject({ status: "scheduled", autoVerdict: "transmit", laneMode: "CANARY" });
    // Drafts are never erased: a re-run finds the SAME send intent (duplicate prevented).
    await sql`update outreach_drafts set scheduled_send_at = null where reply_to_id is not null`;
    await sql`truncate prospect_report_qa_runs, prospect_fulfillment_artifacts, prospect_fact_manifests, prospect_report_handoffs cascade`;
    lane("CANARY", { AUTONOMOUS_POSITIVE_REPLY_CANARY_PERCENT: "0" });
    await rh.processReportHandoffs(NOON, { caller: passingCaller });
    expect((await rh.handoffForProspect(prospectId))!).toMatchObject({ status: "release_ready", autoVerdict: "would_send" });
    expect((await sql`select count(*)::int as n from outreach_drafts where reply_to_id is not null and prospect_id = ${prospectId}`)[0]!.n).toBe(1);
    expect((await sql`select count(*)::int as n from audit_log where action = 'prospect.fulfillment_duplicate_prevented'`)[0]!.n).toBe(1);
    const { fulfillmentMetrics } = await import("@/lib/prospects/fulfillment-lane");
    const metrics = await fulfillmentMetrics(new Date("2026-01-01"));
    expect(metrics).toMatchObject({ autonomyEligible: 1, shadowWouldSend: 1, autonomousSends: 0, duplicateActionPrevented: 1 });
  });


  // ------------------------------------------------------------ spec 138
  describe("spec 138: personalized video walkthrough lane", () => {
    const VIDEO_ENV = ["VIDEO_WALKTHROUGH_MODE", "VIDEO_WALKTHROUGH_KILL_SWITCH", "VIDEO_WALKTHROUGH_RELEASE_KILL_SWITCH", "VIDEO_TTS_PROVIDER", "VIDEO_ALLOW_FIXTURE_INTRO"] as const;
    let assetRoot = "";
    let vw: typeof import("@/lib/prospects/video-walkthrough");
    let tts: typeof import("@/lib/video/tts");
    let render: typeof import("@/lib/video/render");
    beforeAll(async () => {
      vw = await import("@/lib/prospects/video-walkthrough");
      tts = await import("@/lib/video/tts");
      render = await import("@/lib/video/render");
      const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      assetRoot = mkdtempSync(join(tmpdir(), "video-assets-"));
      mkdirSync(join(assetRoot, "founder-intro"), { recursive: true });
      writeFileSync(join(assetRoot, "founder-intro", "founder-intro-fixture.mp4"), "FIXTURE INTRO CLIP");
    });
    const videoEnv = (extra: Record<string, string> = {}): void => {
      for (const k of VIDEO_ENV) delete process.env[k];
      Object.assign(process.env, { VIDEO_TTS_PROVIDER: "mock", VIDEO_ALLOW_FIXTURE_INTRO: "true" }, extra);
    };
    const prepared = async () => {
      lane("SHADOW"); videoEnv();
      await sayYes();
      await rh.processReportHandoffs(NOON, { caller: passingCaller });
      const h = (await rh.handoffForProspect(prospectId))!;
      expect(h.status).toBe("release_ready");
      const v = (await vw.videoForHandoff(h.id))!;
      return { h, v };
    };
    const runJob = (id: string, over: Partial<Parameters<typeof vw.processVideoWalkthroughJob>[1]> = {}) =>
      vw.processVideoWalkthroughJob(id, { tts: tts.mockTtsProvider(), render: render.mockRenderDeps(), caller: passingCaller, assetRoot, workerId: "w1", ...over });

    it("50/1/2/52/54: a verified handoff enqueues ONE video over the SAME manifest as the report; the job renders to release_ready and the release gate sees it (SHADOW: held)", async () => {
      const { h, v } = await prepared();
      expect(v.stage).toBe("queued");
      expect(v.manifestId).toBe(h.manifestId);
      const [mrow] = await sql`select manifest_hash from prospect_fact_manifests where id = ${h.manifestId}`;
      expect(v.meta.manifestHash).toBe(mrow!.manifestHash);
      expect(v.meta.reportArtifactId).toBeTruthy();
      expect((await sql`select count(*)::int as n from jobs where type = 'render_video_walkthrough'`)[0]!.n).toBe(1);
      // Another lane pass creates nothing new (54).
      await rh.processReportHandoffs(NOON, { caller: passingCaller });
      expect((await sql`select count(*)::int as n from prospect_fulfillment_artifacts where handoff_id = ${h.id} and kind = 'video_walkthrough'`)[0]!.n).toBe(1);
      const done = (await runJob(v.id))!;
      expect(done.stage).toBe("release_ready");
      expect(done.status).toBe("ready");
      expect(done.meta.render!.durationMs).toBeGreaterThanOrEqual(55_000);
      expect(done.meta.render!.durationMs).toBeLessThanOrEqual(95_000);
      expect(done.meta.narration!.provider).toBe("mock");
      expect(done.meta.narration!.segments.length).toBe(8);
      expect(done.meta.distribution).toMatchObject({ kind: "local_storage", visibility: "ACCESS_GATED" });
      expect(JSON.stringify(done.meta)).not.toMatch(/xi-api-key|ELEVENLABS_API_KEY/);
      const files = await sql`select kind, mime_type from evidence_artifacts where storage_key like ${`video-walkthrough/${h.id}/%`} order by kind`;
      expect(files.map((f) => `${f.kind}:${f.mimeType}`)).toEqual(["export_file:text/vtt", "video:video/mp4"]);
      const qa = await sql`select kind, passed from prospect_report_qa_runs where handoff_id = ${h.id} and kind like 'video_%' order by kind`;
      expect(qa.map((q) => `${q.kind}=${q.passed}`)).toEqual(["video_artifact_qa=true", "video_script_qa=true", "video_semantic_review=true"]);
      expect(await vw.videoReleaseRecheck(h.id)).toMatchObject({ passed: true, stage: "release_ready" });
      expect((await rh.fulfillmentSendRecheck(sql, h.draftId!)).detail).toContain("video release_ready");
      expect(await vw.videoStatusForHandoff(h.id)).toBe("release-ready, held (SHADOW)");
      const rec = (await vw.reconstructVideoWalkthrough(v.id))!;
      expect((rec.qaRuns as unknown[]).length).toBe(3);
      expect((rec.files as unknown[]).length).toBe(2);
      expect((rec.jobs as unknown[]).length).toBe(1);
      // The email that goes out never marks the video as sent (V1 does not carry it).
      unwrap(await svc.sendProspectDraft(operator, { draftId: h.draftId!, channel: "manual", businessPurpose: "Deliver the report he asked for" }));
      await rh.processReportHandoffs(NOON, { caller: passingCaller });
      expect((await vw.getVideoArtifact(v.id))!.status).toBe("ready");
    });

    it("44/32/21: two workers on the same job produce one video; a render failure retries idempotently without re-synthesizing narration", async () => {
      const { v } = await prepared();
      let ttsCalls = 0;
      let composes = 0;
      let failFirst = true;
      const deps = () => ({
        tts: tts.mockTtsProvider({ onCall: () => { ttsCalls += 1; } }),
        render: render.mockRenderDeps({ onCompose: () => { composes += 1; }, failCompose: () => { if (failFirst) { failFirst = false; return new ClassifiedError("timeout", "ffmpeg exceeded budget"); } return null; } }),
      });
      await expect(runJob(v.id, deps())).rejects.toThrow(/ffmpeg exceeded/);
      let row = (await vw.getVideoArtifact(v.id))!;
      expect(row.stage).toBe("failed_retryable");
      expect(row.meta.failureClass).toBe("RETRYABLE");
      // Narration is content-addressed on disk (script hash + voice + segment):
      // a previous case with the same script may already have paid for it.
      const afterFirstAttempt = ttsCalls;
      expect(afterFirstAttempt).toBeLessThanOrEqual(8);
      const [a, b] = await Promise.all([runJob(v.id, deps()), runJob(v.id, deps())]);
      row = (await vw.getVideoArtifact(v.id))!;
      expect(row.stage).toBe("release_ready");
      expect([a!.stage, b!.stage]).toContain("release_ready");
      expect(ttsCalls).toBe(afterFirstAttempt); // nothing re-synthesized on retry or by the second worker
      expect(composes).toBe(2); // the failed attempt + exactly one successful render
      expect((await sql`select count(*)::int as n from evidence_artifacts where kind = 'video' and storage_key like ${`video-walkthrough/${row.handoffId}/%`}`)[0]!.n).toBe(1);
      expect(row.meta.narration!.cachedSegments).toBe(8);
    });

    it("19/51: a semantic BLOCK parks the video for review and leaves the report and email untouched", async () => {
      const { h, v } = await prepared();
      const row = (await runJob(v.id, { caller: blockingCaller }))!;
      expect(row.stage).toBe("review_required");
      expect(row.meta.reason).toMatch(/semantic review/);
      expect((await rh.handoffForProspect(prospectId))!.status).toBe("release_ready");
      const arts = await sql`select kind, status from prospect_fulfillment_artifacts where handoff_id = ${h.id} and kind in ('private_report', 'positive_reply_email')`;
      expect(arts.every((a) => a.status === "ready")).toBe(true);
      expect((await vw.videoReleaseRecheck(h.id)).passed).toBe(false);
      // Founder requeue after fixing the cause; a passing pass finishes it.
      await vw.requeueVideoWalkthrough(operator, v.id, "wording reviewed by hand");
      expect((await runJob(v.id))!.stage).toBe("release_ready");
    });

    it("28: a 112-second render fails VIDEO_DURATION_QA (never sped up to fit); 31: a missing founder intro blocks before any spend", async () => {
      const { v } = await prepared();
      const long = (await runJob(v.id, { render: render.mockRenderDeps({ probeOverride: { durationMs: 112_000 } }) }))!;
      expect(long.stage).toBe("review_required");
      expect(long.meta.reason).toMatch(/^VIDEO_DURATION_QA_FAIL/);
      await sql`truncate prospect_report_qa_runs, prospect_fulfillment_artifacts, prospect_fact_manifests, prospect_report_handoffs, jobs cascade`;
      const { v: v2 } = await prepared();
      let ttsCalls = 0;
      const missing = (await runJob(v2.id, { assetRoot: join(assetRoot, "nope"), tts: tts.mockTtsProvider({ onCall: () => { ttsCalls += 1; } }) }))!;
      expect(missing.stage).toBe("review_required");
      expect(missing.meta.reason).toMatch(/FOUNDER_INTRO_MISSING/);
      expect(ttsCalls).toBe(0);
    });

    it("41/42/53/7: evidence corrected during the render marks the artifact stale; it can never pass the release gate", async () => {
      const { h, v } = await prepared();
      const seq = (await fu.sequenceForProspect(prospectId))!;
      const [t1] = await sql`select id from outreach_drafts where prospect_id = ${prospectId} and evidence_snapshot is not null order by created_at asc limit 1`;
      const [run] = await sql`select id from runs limit 1`;
      const corrected = { ...snapshot, competitor: { ...snapshot.competitor, recommendationCount: 29 } };
      const correctDuringRender = render.mockRenderDeps({
        onCompose: () => {
          void sql`insert into outreach_evidence_corrections (prospect_id, evidence_draft_id, send_id, source_run_id, original_snapshot, corrected_snapshot, reason, corrected_by)
            values (${prospectId}, ${t1!.id}, ${seq.touch1SendId}, ${run!.id}, ${sql.json(snapshot as never)}, ${sql.json(corrected as never)}, 'competitor alias added', ${operator.id})`.execute();
        },
      });
      const row = (await runJob(v.id, { render: correctDuringRender }))!;
      expect(row.stage).toBe("stale");
      expect(row.status).toBe("stale");
      expect(row.meta.reason).toMatch(/SEND_TIME_REVALIDATION_FAILED|superseded/);
      expect((await vw.videoReleaseRecheck(h.id)).passed).toBe(false);
      await expect(vw.requeueVideoWalkthrough(operator, v.id, "x")).rejects.toThrow(/stale/);
      // The email's own recheck sees the same stale state.
      expect((await rh.fulfillmentSendRecheck(sql, h.draftId!)).passed).toBe(false);
    });

    it("43: a suppression before delivery blocks the video's release; the kill switches stop new jobs and release", async () => {
      const { h, v } = await prepared();
      expect((await runJob(v.id))!.stage).toBe("release_ready");
      const { suppress } = await import("@/lib/outreach/suppression");
      await sql.begin(async (tx) => { await suppress(tx, { scope: "email", value: RECIPIENT, reason: "opt_out", detail: "test", projectId: null, userId: operator.id }); });
      const rc = await vw.videoReleaseRecheck(h.id);
      expect(rc.passed).toBe(false);
      expect(rc.detail).toMatch(/TERMINAL: suppressed/);
      expect((await vw.videoReleaseRecheck(h.id, { ...process.env, VIDEO_WALKTHROUGH_RELEASE_KILL_SWITCH: "true" })).detail).toMatch(/RELEASE_KILL_SWITCH/);
      await sql`truncate prospect_report_qa_runs, prospect_fulfillment_artifacts, prospect_fact_manifests, prospect_report_handoffs, jobs, suppression_entries cascade`;
      lane("SHADOW"); videoEnv({ VIDEO_WALKTHROUGH_KILL_SWITCH: "true" });
      await sayYes();
      await rh.processReportHandoffs(NOON, { caller: passingCaller });
      const h2 = (await rh.handoffForProspect(prospectId))!;
      expect(h2.status).toBe("release_ready");
      expect(await vw.videoForHandoff(h2.id)).toBeNull();
      expect((await sql`select count(*)::int as n from jobs where type = 'render_video_walkthrough'`)[0]!.n).toBe(0);
    });
  });
});
