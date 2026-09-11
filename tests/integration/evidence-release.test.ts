/**
 * Spec 136 — evidence release verification against a real frozen run.
 * Seeds an OpenAI run (2 prompts × 3 repetitions), a foreign-provider cell
 * and an errored cell, licensed RealTrends TEAM records for both sides with
 * verified lead aliases, then proves: the consistent claim verifies;
 * the Blu House state (lead-only answer never classified) blocks; once
 * classified the sent claim needs a correction and the corrected claim
 * verifies; historical rows are immutable; the send gate refuses a claim
 * whose frozen run is missing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { seedTestActors } from "../helpers/actors";
import { truncateAll } from "../helpers/db";
import { unwrap } from "../helpers/result";
import { seedApprovedFinding, type PipelineModules } from "../helpers/prospect-fixtures";
import { MISMATCH_THRESHOLDS, MISMATCH_TEMPLATE_VERSION } from "@/lib/prospects/constants";
import { PARSER_VERSION_LLM } from "@/lib/constants";
import type { MismatchEvidenceSnapshot } from "@/lib/prospects/mismatch";

const TEST_URL = process.env.TEST_DATABASE_URL;
const operator: CurrentUser = { id: "00000000-0000-4000-8000-000000000401", email: "op@test.local", name: "Operator", role: "operator" };
const admin: CurrentUser = { id: "00000000-0000-4000-8000-000000000001", email: "admin@test.local", name: "Admin", role: "admin" };
const RUN = "36000000-0000-4000-8000-000000000001";
const RT_PROSPECT = "36000000-0000-4000-8000-0000000000a1";
const RT_COMPETITOR = "36000000-0000-4000-8000-0000000000a2";
const LEAD_ONLY = "36000000-0000-4000-8000-0000000000e3";

describe.skipIf(!TEST_URL)("evidence release verification (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let m: PipelineModules;
  let er: typeof import("@/lib/prospects/evidence-release");
  let ea: typeof import("@/lib/prospects/entity-aliases");
  let ec: typeof import("@/lib/prospects/evidence-corrections");
  let prospectId = "";
  let findingId = "";
  let BLU = "";
  let HARBOR = "";
  let promptIds: string[] = [];

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    await truncateAll(sql);
    m = {
      sql,
      svc: await import("@/lib/prospects/service"),
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
    er = await import("@/lib/prospects/evidence-release");
    ea = await import("@/lib/prospects/entity-aliases");
    ec = await import("@/lib/prospects/evidence-corrections");
    await seedTestActors(sql);
  });
  afterAll(async () => {
    await sql.end();
  });

  const snapshot = (prospectCount: number): MismatchEvidenceSnapshot => ({
    templateVersion: MISMATCH_TEMPLATE_VERSION, runId: RUN, provider: "openai", answerCount: 6, modelCount: 1,
    capturedAt: "2026-08-31T11:13:56Z", completedAt: "2026-08-31T11:13:56Z", scopeCopy: "Grand Rapids buyer and seller questions", audiences: ["buyer"],
    prospect: { companyId: BLU, prospectId, name: "Blu House Properties", recommendationCount: prospectCount, productionSignalId: RT_PROSPECT, productionSourceUrl: "licensed:realtrends-verified-2026", productionYear: 2025, productionValue: 81_103_589, productionDisplay: "$81.1M closed" },
    competitor: { companyId: HARBOR, prospectId: null, name: "Harbor View Group", recommendationCount: 3, productionSignalId: RT_COMPETITOR, productionSourceUrl: "licensed:realtrends-verified-2026", productionYear: 2025, productionValue: 65_529_015, productionDisplay: "$65.5M closed", productionRatio: 0.808, recommendationGap: 3 - prospectCount },
    metricType: "closed_volume", thresholds: MISMATCH_THRESHOLDS,
  });

  /** Seeds the frozen run. `leadOnlyClassified` = the parser considered the
   * answer that names only Ryan Ogle (a mention row exists). */
  async function seed(leadOnlyClassified: boolean): Promise<void> {
    await truncateAll(sql);
    (await import("@/lib/ai/mock")).resetMockProvider();
    const f = await seedApprovedFinding(m, operator, admin, { projectKind: "prospect" });
    prospectId = f.prospectId;
    findingId = f.findingId;
    BLU = f.prospectCompanyId;
    HARBOR = f.subjectCompanyId;
    await sql`update companies set name = 'Blu House Properties' where id = ${BLU}`;
    await sql`update companies set name = 'Harbor View Group' where id = ${HARBOR}`;
    await sql`update prospects set business_name = 'Blu House Properties', team_leader = 'Ryan John Ogle' where id = ${prospectId}`;
    await sql`
      insert into realtrends_records (id, fingerprint, dataset_name, entity_type, entity_name, city, state, volume_usd, sides, production_year, source_sheet, source_row, team_lead, company_id, match_status, matched_at)
      values (${RT_PROSPECT}, 'fp-blu', 'test', 'team', 'Blu House Properties', 'Grand Rapids', 'MI', 81103589, 120, 2025, 'Teams', 1, 'Ryan John Ogle', ${BLU}, 'confirmed', now()),
             (${RT_COMPETITOR}, 'fp-harbor', 'test', 'team', 'Harbor View Group', 'Grand Rapids', 'MI', 65529015, 90, 2025, 'Teams', 2, 'Dana Harbor', ${HARBOR}, 'confirmed', now())
    `;
    await ea.applyVerifiedAliases(operator, BLU);
    await ea.applyVerifiedAliases(operator, HARBOR);
    const [v] = await sql`select frozen_prompts from prompt_set_versions where id = ${f.versionId}`;
    promptIds = (v!.frozenPrompts as { promptId: string; position: number }[]).sort((a, b) => a.position - b.position).map((p) => p.promptId);
    await sql`
      insert into runs (id, project_id, prompt_set_version_id, label, providers, status, trigger, budget_usd, completed_at)
      values (${RUN}, ${f.projectId}, ${f.versionId}, 'frozen', ${sql.json([{ provider: "openai", model: "gpt-test", repetitions: 3 }] as never)}, 'partial', 'manual', 1, now())
    `;
    const [pA, pB] = promptIds as [string, string];
    const cells: [string, string, string, number, string | null, string | null][] = [
      ["36000000-0000-4000-8000-0000000000e1", pA, "openai", 1, "Ryan Ogle at Blu House Properties stands out; Harbor View Group is also strong.", null],
      ["36000000-0000-4000-8000-0000000000e2", pA, "openai", 2, "Consider Harbor View Group or a boutique team.", null],
      [LEAD_ONLY, pA, "openai", 3, "Ryan Ogle's team is excellent for Michigan Oaks sellers.", null],
      ["36000000-0000-4000-8000-0000000000e4", pB, "openai", 1, "Harbor View Group is the top pick.", null],
      ["36000000-0000-4000-8000-0000000000e5", pB, "openai", 2, "Darla Ogle leads Ogle Luxury Group.", null],
      ["36000000-0000-4000-8000-0000000000e6", pB, "openai", 3, "Nothing notable here.", null],
      ["36000000-0000-4000-8000-0000000000e7", pA, "perplexity", 1, "Blu House Properties! Harbor View Group!", null],
      ["36000000-0000-4000-8000-0000000000e8", pA, "openai", 1, null, '{"message":"timeout"}'],
    ];
    for (const [id, promptId, provider, rep, text, error] of cells) {
      await sql`
        insert into responses (id, run_id, prompt_id, prompt_text, provider, model, repetition, response_text, error)
        values (${id}, ${RUN}, ${promptId}, 'Who should I hire to sell a home in Grand Rapids?', ${provider}, ${provider === "openai" ? "gpt-test" : "sonar"}, ${rep}, ${text}, ${error === null ? null : sql.json(JSON.parse(error))})
      `;
    }
    const rows: [string, string, boolean][] = [
      ["36000000-0000-4000-8000-0000000000e1", BLU, true], ["36000000-0000-4000-8000-0000000000e1", HARBOR, true],
      ["36000000-0000-4000-8000-0000000000e2", HARBOR, true], ["36000000-0000-4000-8000-0000000000e4", HARBOR, true],
      ["36000000-0000-4000-8000-0000000000e7", BLU, true], ["36000000-0000-4000-8000-0000000000e7", HARBOR, true],
    ];
    if (leadOnlyClassified) rows.push([LEAD_ONLY, BLU, true]);
    for (const [rid, cid, rec] of rows) await mention(rid, cid, rec, 1);
  }
  async function mention(responseId: string, companyId: string, recommended: boolean, revision: number): Promise<void> {
    await sql`
      insert into mentions (response_id, company_id, revision, mentioned, recommended, parser_version, confidence)
      values (${responseId}, ${companyId}, ${revision}, true, ${recommended}, ${PARSER_VERSION_LLM}, 0.9)
    `;
  }
  async function deliveredDraft(s: MismatchEvidenceSnapshot): Promise<{ draftId: string; sendId: string }> {
    const [d] = await sql`
      insert into outreach_drafts (prospect_id, finding_id, channel, version, subject, body, generated_by, prompt_version, evidence_snapshot, status, approved_by, approved_at, created_by, sent_recorded_at)
      values (${prospectId}, ${findingId}, 'email', 1, 'Ryan - Grand Rapids', 'body', 'system', ${MISMATCH_TEMPLATE_VERSION}, ${sql.json(s as never)}, 'approved', ${operator.id}, now(), ${operator.id}, now())
      returning id
    `;
    const [snd] = await sql`
      insert into prospect_outreach_sends (draft_id, prospect_id, channel, recipient_email, body_hash, business_purpose, gate_verdict, allowed, provider_message_id, sent_by, gmail_thread_id)
      values (${d!.id}, ${prospectId}, 'gmail', 'ryan@blu.example', 'h', 'test', '{}', true, 'gm-1', ${operator.id}, 'thread-1')
      returning id
    `;
    return { draftId: d!.id as string, sendId: snd!.id as string };
  }

  beforeEach(async () => {
    await seed(true);
  });

  it("a consistent frozen claim verifies: primary = shadow = stated; foreign provider and errored cells excluded; both TEAM levels licensed", async () => {
    const v = await er.verifyEvidenceRelease(snapshot(2), { prospectId, sendId: null });
    expect(v.reasons).toEqual([]);
    expect(v.verified).toBe(true);
    expect(v.diagnostics).toMatchObject({
      expectedCells: 6, validCells: 6, errorCells: 1, otherProviderCells: 1,
      primary: { prospect: 2, competitor: 3, denominator: 6 },
      shadow: { prospect: 2, competitor: 3, denominator: 6 },
      entityLevels: { prospect: "team", competitor: "team" },
      productionRecords: { prospect: RT_PROSPECT, competitor: RT_COMPETITOR },
      parserVersions: [PARSER_VERSION_LLM],
    });
    const rel = v.checks.find((c) => c.name === "RELATIONSHIPS_VERIFIED")!;
    expect(rel.passed).toBe(true);
    expect(rel.detail).toContain("Ryan John Ogle (licensed RealTrends record)");
  });

  it("Blu House property end to end: unconsidered lead-only answer blocks; classified → sent claim stale → correction recorded → corrected claim verifies; history immutable", async () => {
    await seed(false);
    const sent = snapshot(1); // what Touch 1 stated: internally consistent with the rows of the day
    const { draftId, sendId } = await deliveredDraft(sent);
    const ctx = { prospectId, sendId };

    const blocked = await er.verifyEvidenceRelease(sent, ctx);
    expect(blocked.verified).toBe(false);
    expect(blocked.reasons).toContain("ALIAS_COVERAGE_UNVERIFIED");
    expect(blocked.diagnostics.primary.prospect).toBe(1);
    expect(blocked.diagnostics.shadow.prospect).toBe(1); // consistent, incomplete
    expect(blocked.diagnostics.coverageGaps.prospect).toBe(1);

    // Re-resolution (append-only revision over the SAME answer).
    await mention(LEAD_ONLY, BLU, true, 1);
    const stale = await er.verifyEvidenceRelease(sent, ctx);
    expect(stale.reasons).toEqual(["STATED_COUNT_MISMATCH"]);
    expect(stale.diagnostics.primary.prospect).toBe(2);
    expect(stale.diagnostics.shadow.prospect).toBe(2);

    // Correction ledger (spec 130): insert-only beside the frozen claim.
    const rec = await ec.recordEvidenceCorrection(operator, {
      prospectId, evidenceDraftId: draftId, sendId, original: sent, reason: "lead alias re-resolution",
      change: { aliasesAdded: {}, mentionRowsAdded: { [BLU]: 1 } },
    });
    expect(rec.recorded).toBe(true);
    expect(rec.corrected.prospect.recommendationCount).toBe(2);
    const afterCorrection = await er.verifyEvidenceRelease(sent, ctx);
    expect(afterCorrection.reasons).toEqual(expect.arrayContaining(["STATED_COUNT_MISMATCH", "PENDING_CORRECTION"]));
    const corrected = await er.verifyEvidenceRelease(rec.corrected, ctx);
    expect(corrected.verified).toBe(true);
    expect(corrected.diagnostics.correctionId).toBe(rec.correction!.id);

    // What was sent stays exactly as sent.
    const [draft] = await sql`select evidence_snapshot from outreach_drafts where id = ${draftId}`;
    expect(draft!.evidenceSnapshot).toEqual(sent);
    await expect(sql`update outreach_evidence_corrections set reason = 'x' where id = ${rec.correction!.id}`).rejects.toThrow();
    await expect(sql`update mentions set recommended = false where response_id = ${LEAD_ONLY}`).rejects.toThrow();
    await expect(sql`update responses set response_text = 'x' where id = ${LEAD_ONLY}`).rejects.toThrow();
    await expect(sql`delete from outreach_evidence_corrections where id = ${rec.correction!.id}`).rejects.toThrow();
  });

  it("a paused sequence cannot resume while its effective evidence is blocked", async () => {
    await seed(false);
    const { draftId, sendId } = await deliveredDraft(snapshot(1));
    const [seq] = await sql`
      insert into outreach_followup_sequences (prospect_id, experiment_id, touch1_draft_id, touch1_send_id, competitor_company_id, evidence_snapshot, timezone, status, pause_reason, enrolled_by)
      values (${prospectId}, 'x', ${draftId}, ${sendId}, ${HARBOR}, ${sql.json(snapshot(1) as never)}, 'America/Detroit', 'paused', 'operator: evidence correction', ${operator.id})
      returning id
    `;
    const fu = await import("@/lib/prospects/followups");
    const r = await fu.resumeFollowupSequence(operator, { sequenceId: seq!.id });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain("ALIAS_COVERAGE_UNVERIFIED");
    const [row] = await sql`select status from outreach_followup_sequences where id = ${seq!.id}`;
    expect(row!.status).toBe("paused");
  });

  it("send-time gate: a claim whose frozen run is gone is refused with deterministic reasons on the ledger (gate v3)", async () => {
    const { setSenderIdentity } = await import("@/lib/outreach/sender-identity");
    unwrap(await setSenderIdentity(admin, { senderName: "Dana Operator", companyName: "AVOS Agency LLC", postalAddress: "123 Grand St, Jersey City, NJ 07302", replyToEmail: "dana@avos.agency" }));
    const contact = unwrap(await m.svc.addContact(operator, { prospectId, name: "Ryan Ogle", email: "ryan@blu.example", isPrimary: true }));
    const gone = { ...snapshot(2), runId: "36000000-0000-4000-8000-00000000dead" };
    const [d] = await sql`
      insert into outreach_drafts (prospect_id, finding_id, channel, contact_id, version, subject, body, generated_by, evidence_snapshot, status, approved_by, approved_at, created_by)
      values (${prospectId}, ${findingId}, 'email', ${contact.contactId}, 1, 'Ryan - Grand Rapids', 'Ryan, a short note.\n\n123 Grand St, Jersey City, NJ 07302\nReply "unsubscribe" to opt out.', 'operator', ${sql.json(gone as never)}, 'approved', ${operator.id}, now(), ${operator.id})
      returning id
    `;
    const res = await m.svc.sendProspectDraft(operator, { draftId: d!.id as string, channel: "mock", businessPurpose: "Benchmark findings relevant to their market position." });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.message).toContain("EVIDENCE_RELEASE_BLOCKED");
      expect(res.error.message).toContain("FROZEN_RUN_MISSING");
    }
    const [ledger] = await sql`select allowed, gate_verdict from prospect_outreach_sends where draft_id = ${d!.id}`;
    expect(ledger!.allowed).toBe(false);
    const verdict = ledger!.gateVerdict as { version: string; checks: { name: string; passed: boolean; detail: string }[] };
    expect(verdict.version).toBe("prospect-send-gate-v3");
    const release = verdict.checks.find((c) => c.name === "evidence_release_verified")!;
    expect(release.passed).toBe(false);
    expect(release.detail).toContain('"version":"evidence-release-v1"');
  });
});
