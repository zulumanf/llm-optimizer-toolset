/**
 * Spec 150 — pre-send outreach hardening, end to end through the real
 * services: the finding's OWN run controls freshness, providers are named
 * only with valid evidence, the postal-address gate, audit expiry at send,
 * and no grandfathering — an approved or scheduled draft that becomes
 * invalid is REFUSED at transmission.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { adminUser, operatorUser, seedTestActors } from "../helpers/actors";
import { truncateAll } from "../helpers/db";
import { seedApprovedFinding, type PipelineModules } from "../helpers/prospect-fixtures";
import { unwrap } from "../helpers/result";

const TEST_URL = process.env.TEST_DATABASE_URL;
const operator = operatorUser();
const admin = adminUser();
const PURPOSE = "Benchmark findings relevant to their market position.";
const COMPLETE_ADDRESS = "123 Grand St, Jersey City, NJ 07302";

describe.skipIf(!TEST_URL)("pre-send outreach hardening (spec 150, integration)", () => {
  let m: PipelineModules;
  let sql: PipelineModules["sql"];
  let svc: PipelineModules["svc"];
  let fixture: Awaited<ReturnType<typeof seedApprovedFinding>>;
  let contactId: string;

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    await truncateAll(sql);
    svc = await import("@/lib/prospects/service");
    m = {
      sql,
      svc,
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
    await seedTestActors(sql);
  });

  beforeEach(async () => {
    vi.unstubAllEnvs();
    await sql.unsafe(
      `truncate audit_log, jobs, suppression_entries, prospect_outreach_sends,
       prospect_activities, prospect_stage_history, screen_recording_plans,
       outreach_drafts, prospect_contacts, prospect_audit_views, prospect_audit_links, prospect_audits,
       prospect_findings, prospect_benchmarks, prospect_authority_signals,
       prospects, market_launches,
       exclusivity_checks, exclusivity_scopes, exclusivity_agreements, markets,
       claims, competitors, scores, sources, response_parses, mentions,
       response_citations, brand_candidates, companies, responses, runs,
       prompt_set_versions, prompts, prompt_sets, projects cascade`
    );
    (await import("@/lib/ai/mock")).resetMockProvider();
    await sql`truncate outreach_sender_identity`;
    unwrap(
      await (await import("@/lib/outreach/sender-identity")).setSenderIdentity(admin, {
        senderName: "Dana Operator",
        companyName: "AVOS Agency LLC",
        postalAddress: COMPLETE_ADDRESS,
        replyToEmail: "dana@avos.agency",
      })
    );
    fixture = await seedApprovedFinding(m, operator, admin);
    contactId = unwrap(
      await svc.addContact(operator, {
        prospectId: fixture.prospectId,
        name: "Ana Rivera",
        email: "ana@riverateam.com",
        isPrimary: true,
        provenance: "publicly_sourced",
      })
    ).contactId;
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await sql.end();
  });

  const createDraft = () =>
    svc.createOutreachDraft(operator, { prospectId: fixture.prospectId, channel: "email", contactId });

  async function approvedDraft(): Promise<string> {
    const { draftId } = unwrap(await createDraft());
    unwrap(await svc.approveOutreachDraft(operator, { draftId }));
    return draftId;
  }

  const ageFindingRun = (days: number) =>
    sql`update runs set completed_at = now() - make_interval(days => ${days}) where id = ${fixture.runId}`;

  async function linkNewerUnrelatedRun(): Promise<void> {
    const [newer] = await sql`
      insert into runs (project_id, prompt_set_version_id, label, providers, status, trigger, started_by, budget_usd, started_at, completed_at)
      select project_id, prompt_set_version_id, 'newer unrelated', providers, 'completed', trigger, started_by, budget_usd,
        now() - interval '4 days', now() - interval '4 days'
      from runs where id = ${fixture.runId}
      returning id
    `;
    await sql`
      insert into prospect_benchmarks (prospect_id, run_id, company_id, created_by)
      values (${fixture.prospectId}, ${newer!.id}, ${fixture.prospectCompanyId}, ${operator.id})
    `;
  }

  async function ledger(draftId: string) {
    return sql`select allowed, gate_verdict from prospect_outreach_sends where draft_id = ${draftId} order by sent_at`;
  }

  describe("finding-specific freshness", () => {
    it("a finding from its own fresh run drafts, approves and sends", async () => {
      const draftId = await approvedDraft();
      unwrap(await svc.sendProspectDraft(operator, { draftId, channel: "mock", businessPurpose: PURPOSE }));
    });

    it("a 49-day-old finding cannot be drafted even with a 4-day-old run linked to the prospect", async () => {
      await ageFindingRun(49);
      await linkNewerUnrelatedRun();
      const res = await createDraft();
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.message).toContain("RUN_STALE");
    });

    it("an approved draft whose finding goes stale is refused at send, ledgered", async () => {
      const draftId = await approvedDraft();
      await ageFindingRun(49);
      await linkNewerUnrelatedRun();
      const res = await svc.sendProspectDraft(operator, { draftId, channel: "mock", businessPurpose: PURPOSE });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.message).toContain("finding_evidence");
      const rows = await ledger(draftId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.allowed).toBe(false);
      const [d] = await sql`select sent_recorded_at from outreach_drafts where id = ${draftId}`;
      expect(d!.sentRecordedAt).toBeNull();
    });

    it("a scheduled draft that goes stale cannot be (re)scheduled and is refused by the unattended send", async () => {
      const draftId = await approvedDraft();
      unwrap(await svc.scheduleDraftSend(operator, { draftId, sendAt: new Date(Date.now() + 3_600_000), businessPurpose: PURPOSE }));
      await ageFindingRun(20);
      const res = await svc.sendProspectDraft(operator, { draftId, channel: "mock", businessPurpose: PURPOSE, unattended: true });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.message).toContain("RUN_STALE");
      const again = await svc.scheduleDraftSend(operator, { draftId, sendAt: new Date(Date.now() + 7_200_000), businessPurpose: PURPOSE });
      expect(again.ok).toBe(false);
      if (!again.ok) expect(again.error.message).toContain("finding_evidence");
    });

    it("tenant safety: a finding whose benchmark belongs to another prospect never satisfies the gate", async () => {
      const other = unwrap(await svc.createProspect(operator, { launchId: fixture.launchId, businessName: "Harbor Team", prospectType: "team" }));
      const [foreignBench] = await sql`
        insert into prospect_benchmarks (prospect_id, run_id, company_id, created_by)
        values (${other.prospectId}, ${fixture.runId}, ${fixture.prospectCompanyId}, ${operator.id}) returning id
      `;
      const draftId = await approvedDraft();
      await sql`update prospect_findings set benchmark_id = ${foreignBench!.id} where id = ${fixture.findingId}`;
      const res = await svc.sendProspectDraft(operator, { draftId, channel: "mock", businessPurpose: PURPOSE });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.message).toContain("BENCHMARK_FOREIGN");
    });

    it("tenant safety: a draft pointing at another prospect's finding is refused", async () => {
      const other = unwrap(await svc.createProspect(operator, { launchId: fixture.launchId, businessName: "Harbor Team", prospectType: "team" }));
      const [f] = await sql`
        insert into prospect_findings (prospect_id, benchmark_id, kind, title, explanation, generator_version, status, response_ids)
        select ${other.prospectId}, ${fixture.benchmarkId}, 'absence', 'Harbor absent', 'Harbor absent.', 'test', 'approved', response_ids
        from prospect_findings where id = ${fixture.findingId}
        returning id
      `;
      const { draftId } = unwrap(await createDraft());
      // Repoint while still a draft (approved rows are immutable), then mark
      // it approved as a legacy/out-of-band row would be.
      await sql`update outreach_drafts set finding_id = ${f!.id} where id = ${draftId}`;
      const approve = await svc.approveOutreachDraft(operator, { draftId });
      expect(approve.ok).toBe(false);
      if (!approve.ok) expect(approve.error.message).toContain("FINDING_FOREIGN");
      await sql`update outreach_drafts set status = 'approved', approved_by = ${operator.id}, approved_at = now() where id = ${draftId}`;
      const res = await svc.sendProspectDraft(operator, { draftId, channel: "mock", businessPurpose: PURPOSE });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.message).toContain("FINDING_FOREIGN");
    });
  });

  describe("provider attribution", () => {
    it("a configured provider with zero valid answers is never named, and a body that names it is refused", async () => {
      // Perplexity configured on the run, every one of its cells errored.
      await sql`
        insert into responses (run_id, prompt_id, prompt_text, provider, model, repetition, raw_payload, error)
        select run_id, prompt_id, prompt_text, 'perplexity', 'sonar', repetition, '{"error":"insufficient_quota"}'::jsonb, '{"kind":"provider_quota","message":"insufficient_quota"}'::jsonb
        from responses where run_id = ${fixture.runId}
      `;
      const { draftId } = unwrap(await createDraft());
      const [d] = await sql`select body from outreach_drafts where id = ${draftId}`;
      const body = d!.body as string;
      expect(body).not.toMatch(/perplexity/i);
      expect(body).not.toMatch(/\bmock\b/);
      expect(body).not.toContain("Both measurements are shown with their sources");

      await sql`update outreach_drafts set body = replace(body, '(', 'via Perplexity (') where id = ${draftId}`;
      const res = await svc.approveOutreachDraft(operator, { draftId });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.message).toContain("provider_attribution");
    });
  });

  describe("entity wording", () => {
    it("an individual agent's generated draft never calls them a team; an old team-worded body is refused", async () => {
      await sql`update prospects set prospect_type = 'individual_agent' where id = ${fixture.prospectId}`;
      const { draftId } = unwrap(await createDraft());
      const [d] = await sql`select body from outreach_drafts where id = ${draftId}`;
      expect(d!.body as string).toMatch(/recommend \S+ agents/);
      expect(d!.body as string).not.toMatch(/\bteams?\b/);

      await sql`update outreach_drafts set body = replace(body, ' agents ', ' teams ') where id = ${draftId}`;
      const res = await svc.approveOutreachDraft(operator, { draftId });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.message).toContain("entity_wording");
    });
  });

  describe("postal-address hard gate", () => {
    it("an incomplete address cannot be saved", async () => {
      const { setSenderIdentity } = await import("@/lib/outreach/sender-identity");
      for (const postalAddress of ["Brooklyn, NY", ""]) {
        const res = await setSenderIdentity(admin, { senderName: "Dana", companyName: "AVOS", postalAddress, replyToEmail: "dana@avos.agency" });
        expect(res.ok).toBe(false);
      }
    });

    it("a legacy incomplete identity blocks drafting, approval, scheduling and an already-approved send", async () => {
      const draftId = await approvedDraft();
      const pending = unwrap(await createDraft()).draftId;
      // The production row predates the gate: simulate it directly.
      await sql`update outreach_sender_identity set postal_address = 'Brooklyn, NY' where active`;

      const created = await createDraft();
      expect(created.ok).toBe(false);
      if (!created.ok) expect(created.error.message).toContain("postal address is incomplete");

      const approve = await svc.approveOutreachDraft(operator, { draftId: pending });
      expect(approve.ok).toBe(false);
      if (!approve.ok) expect(approve.error.message).toContain("sender_postal_address");

      const schedule = await svc.scheduleDraftSend(operator, { draftId, sendAt: new Date(Date.now() + 3_600_000), businessPurpose: PURPOSE });
      expect(schedule.ok).toBe(false);

      const send = await svc.sendProspectDraft(operator, { draftId, channel: "mock", businessPurpose: PURPOSE, unattended: true });
      expect(send.ok).toBe(false);
      const [row] = await ledger(draftId);
      const checks = (row!.gateVerdict as { checks: { name: string; passed: boolean }[] }).checks;
      expect(checks.find((c) => c.name === "postal_address")?.passed).toBe(false);
    });
  });

  describe("audit expiry", () => {
    it("an approved draft whose linked audit expires before send is refused", async () => {
      vi.stubEnv("APP_URL", "https://avos.example.com");
      unwrap(await svc.publishAudit(operator, { prospectId: fixture.prospectId }));
      const { draftId } = unwrap(await createDraft());
      const [d] = await sql`select body from outreach_drafts where id = ${draftId}`;
      expect(d!.body as string).toContain("https://avos.example.com/audit/");
      // Approved earlier (other checks are not under test here), then the
      // audit lapses before transmission.
      await sql`update outreach_drafts set status = 'approved', approved_by = ${operator.id}, approved_at = now() where id = ${draftId}`;
      await sql`update prospect_audits set expires_at = now() - interval '1 hour' where prospect_id = ${fixture.prospectId}`;
      const res = await svc.sendProspectDraft(operator, { draftId, channel: "mock", businessPurpose: PURPOSE });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.message).toContain("audit_link");
      const [audit] = await sql`select expires_at < now() as expired from prospect_audits where prospect_id = ${fixture.prospectId}`;
      expect(audit!.expired).toBe(true); // never silently extended
    });
  });
});
