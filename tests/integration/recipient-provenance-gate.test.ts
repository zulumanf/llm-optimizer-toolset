/**
 * Spec 148 — recipient provenance send gate. Every outreach gate (approve,
 * schedule, record-sent, transmit — human and unattended) refuses a
 * recipient email that is not send-ready under the ONE canonical rule
 * (verified | publicly_sourced), re-reads it at send time, and never lets
 * another prospect's contact satisfy it. Also: the contact-supply queue
 * reads persisted contact provenance, never an activity-log kind.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminUser, clientViewerUser, operatorUser, seedTestActors } from "../helpers/actors";
import { truncateAll } from "../helpers/db";
import { seedApprovedFinding, type PipelineModules } from "../helpers/prospect-fixtures";
import { unwrap } from "../helpers/result";

const TEST_URL = process.env.TEST_DATABASE_URL;
const operator = operatorUser();
const admin = adminUser();
const clientViewer = clientViewerUser();
const PURPOSE = "Benchmark findings relevant to their market position.";
const VERIFY = /Verify this contact before sending/;

describe.skipIf(!TEST_URL)("recipient provenance send gate (spec 148, integration)", () => {
  let m: PipelineModules;
  let sql: PipelineModules["sql"];
  let svc: PipelineModules["svc"];
  let fixture: Awaited<ReturnType<typeof seedApprovedFinding>>;

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
    await sql.unsafe(
      `truncate audit_log, jobs, suppression_entries, prospect_outreach_sends,
       prospect_activities, prospect_stage_history, screen_recording_plans, enrichment_proposals,
       outreach_drafts, prospect_contacts, prospect_audit_views, prospect_audits,
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
        postalAddress: "123 Grand St, Jersey City, NJ 07302",
        replyToEmail: "dana@avos.agency",
      })
    );
    fixture = await seedApprovedFinding(m, operator, admin);
  });

  afterAll(async () => {
    await sql.end();
  });

  async function contactWith(provenance: string, email = `ana.${provenance}@riverateam.com`): Promise<string> {
    return unwrap(
      await svc.addContact(operator, {
        prospectId: fixture.prospectId,
        name: "Ana Rivera",
        email,
        isPrimary: true,
        provenance,
      })
    ).contactId;
  }

  async function draftTo(contactId: string): Promise<string> {
    return unwrap(
      await svc.createOutreachDraft(operator, {
        prospectId: fixture.prospectId,
        channel: "email",
        contactId,
      })
    ).draftId;
  }

  /** Approved through the real gate with a send-ready contact. */
  async function approvedDraft(): Promise<{ draftId: string; contactId: string }> {
    const contactId = await contactWith("publicly_sourced");
    const draftId = await draftTo(contactId);
    unwrap(await svc.approveOutreachDraft(operator, { draftId }));
    return { draftId, contactId };
  }

  async function ledgerFor(draftId: string) {
    return sql`select allowed, gate_verdict from prospect_outreach_sends where draft_id = ${draftId}`;
  }

  it("an ai_inferred email cannot be approved for send", async () => {
    const draftId = await draftTo(await contactWith("ai_inferred"));
    const res = await svc.approveOutreachDraft(operator, { draftId });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toMatch(VERIFY);
    const [d] = await sql`select status from outreach_drafts where id = ${draftId}`;
    expect(d!.status).toBe("draft");
  });

  it("an ai_inferred email cannot be directly sent, even on a draft already marked approved", async () => {
    const contactId = await contactWith("ai_inferred");
    const draftId = await draftTo(contactId);
    // Legacy / out-of-band approval: the transmission gate must still refuse.
    await sql`update outreach_drafts set status = 'approved', approved_by = ${operator.id}, approved_at = now() where id = ${draftId}`;
    for (const unattended of [false, true]) {
      const res = await svc.sendProspectDraft(operator, { draftId, channel: "mock", businessPurpose: PURPOSE, unattended });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.message).toMatch(VERIFY);
    }
    const ledger = await ledgerFor(draftId);
    expect(ledger).toHaveLength(2);
    expect(ledger.every((r) => r.allowed === false)).toBe(true);
    const checks = (ledger[0]!.gateVerdict as { version: string; checks: { name: string; passed: boolean }[] });
    expect(checks.version).toBe("prospect-send-gate-v5");
    expect(checks.checks.find((c) => c.name === "recipient_email_provenance")?.passed).toBe(false);
    const [d] = await sql`select sent_recorded_at from outreach_drafts where id = ${draftId}`;
    expect(d!.sentRecordedAt).toBeNull();
  });

  it("an ai_inferred email cannot be scheduled or recorded as sent", async () => {
    const { draftId, contactId } = await approvedDraft();
    await sql`update prospect_contacts set provenance = 'ai_inferred' where id = ${contactId}`;
    const scheduled = await svc.scheduleDraftSend(operator, {
      draftId,
      sendAt: new Date(Date.now() + 3_600_000),
      businessPurpose: PURPOSE,
    });
    expect(scheduled.ok).toBe(false);
    if (!scheduled.ok) expect(scheduled.error.message).toMatch(VERIFY);
    const [d] = await sql`select scheduled_send_at from outreach_drafts where id = ${draftId}`;
    expect(d!.scheduledSendAt).toBeNull();
    const recorded = await svc.recordDraftSent(operator, { draftId });
    expect(recorded.ok).toBe(false);
    if (!recorded.ok) expect(recorded.error.message).toMatch(VERIFY);
  });

  it("verified and publicly_sourced emails pass approval and transmission", async () => {
    for (const provenance of ["verified", "publicly_sourced"]) {
      const contactId = await contactWith(provenance);
      const draftId = await draftTo(contactId);
      unwrap(await svc.approveOutreachDraft(operator, { draftId }));
      const sent = unwrap(await svc.sendProspectDraft(operator, { draftId, channel: "mock", businessPurpose: PURPOSE }));
      expect(sent.providerMessageId).toBe(`mock-ana.${provenance}@riverateam.com`);
      const [ledger] = await sql`select allowed, gate_verdict from prospect_outreach_sends where id = ${sent.sendId}`;
      expect(ledger!.allowed).toBe(true);
      const check = (ledger!.gateVerdict as { checks: { name: string; passed: boolean; detail: string }[] }).checks
        .find((c) => c.name === "recipient_email_provenance");
      expect(check).toMatchObject({ passed: true });
      expect(check!.detail).toContain(provenance);
    }
  });

  it("manual, estimated and unknown provenance fail closed", async () => {
    for (const provenance of ["manual", "estimated"]) {
      const draftId = await draftTo(await contactWith(provenance));
      const res = await svc.approveOutreachDraft(operator, { draftId });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.message).toMatch(VERIFY);
    }
    // Contact provenance is NOT NULL and check-constrained; the unconstrained
    // place an unknown label can live is prospects.field_provenance (jsonb).
    await sql`update prospects set email = 'team@riverateam.com' where id = ${fixture.prospectId}`;
    const noContact = unwrap(await svc.createOutreachDraft(operator, { prospectId: fixture.prospectId, channel: "email" })).draftId;
    const missing = await svc.approveOutreachDraft(operator, { draftId: noContact });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.message).toContain('provenance is "unknown"');
    await sql`update prospects set field_provenance = '{"email":"pattern_guess"}' where id = ${fixture.prospectId}`;
    const unknownLabel = await svc.approveOutreachDraft(operator, { draftId: noContact });
    expect(unknownLabel.ok).toBe(false);
    if (!unknownLabel.ok) expect(unknownLabel.error.message).toContain('provenance is "pattern_guess"');
    // Same prospect email under a send-ready field provenance gets past this
    // gate (QA then still requires a bound contact — unchanged).
    await sql`update prospects set field_provenance = '{"email":"publicly_sourced"}' where id = ${fixture.prospectId}`;
    const ready = await svc.approveOutreachDraft(operator, { draftId: noContact });
    if (!ready.ok) expect(ready.error.message).not.toMatch(VERIFY);
  });

  it("a provenance change after approval is re-checked at send time", async () => {
    const { draftId, contactId } = await approvedDraft();
    await sql`update prospect_contacts set provenance = 'ai_inferred' where id = ${contactId}`;
    const refused = await svc.sendProspectDraft(operator, { draftId, channel: "mock", businessPurpose: PURPOSE });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toMatch(VERIFY);
    // Re-verified (e.g. found literally on a public page) → the same draft sends.
    await sql`update prospect_contacts set provenance = 'publicly_sourced' where id = ${contactId}`;
    unwrap(await svc.sendProspectDraft(operator, { draftId, channel: "mock", businessPurpose: PURPOSE }));
  });

  it("the contact the email comes from decides: a send-ready contact without an email does not launder an unverified prospect email", async () => {
    await sql`update prospects set email = 'guess@riverateam.com', field_provenance = '{"email":"ai_inferred"}' where id = ${fixture.prospectId}`;
    const [noEmail] = await sql`
      insert into prospect_contacts (prospect_id, name, phone, provenance)
      values (${fixture.prospectId}, 'Phone Only', '+1 555 0100', 'verified') returning id
    `;
    const draftId = await draftTo(noEmail!.id as string);
    await sql`update outreach_drafts set status = 'approved' where id = ${draftId}`;
    const res = await svc.sendProspectDraft(operator, { draftId, channel: "mock", businessPurpose: PURPOSE });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toContain('provenance is "ai_inferred"');
  });

  it("another prospect's verified contact cannot satisfy this prospect", async () => {
    const other = unwrap(
      await svc.createProspect(operator, { launchId: fixture.launchId, businessName: "Harbor Team", prospectType: "team" })
    );
    const foreign = unwrap(
      await svc.addContact(operator, { prospectId: other.prospectId, name: "Hal", email: "hal@harbor.com", provenance: "verified" })
    ).contactId;
    const [finding] = await sql`select id from prospect_findings where prospect_id = ${fixture.prospectId} limit 1`;
    // Hand-built draft pointing across prospects (createOutreachDraft refuses this at insert).
    const [d] = await sql`
      insert into outreach_drafts (prospect_id, finding_id, channel, contact_id, body, generated_by, status)
      values (${fixture.prospectId}, ${finding!.id}, 'email', ${foreign}, 'Hello. Reply unsubscribe to opt out.', 'operator', 'draft')
      returning id
    `;
    const draftId = d!.id as string;
    const approve = await svc.approveOutreachDraft(operator, { draftId });
    expect(approve.ok).toBe(false);
    if (!approve.ok) expect(approve.error.message).toContain("belongs to a different prospect");
    await sql`update outreach_drafts set status = 'approved' where id = ${draftId}`;
    const send = await svc.sendProspectDraft(operator, { draftId, channel: "mock", businessPurpose: PURPOSE });
    expect(send.ok).toBe(false);
    if (!send.ok) expect(send.error.message).toContain("belongs to a different prospect");
    const ledger = await ledgerFor(draftId);
    expect(ledger.every((r) => r.allowed === false)).toBe(true);
  });

  it("tenant isolation: client roles cannot approve, schedule, record or send", async () => {
    const { draftId } = await approvedDraft();
    const pending = await draftTo(await contactWith("verified"));
    expect((await svc.approveOutreachDraft(clientViewer, { draftId: pending })).ok).toBe(false);
    expect(
      (await svc.scheduleDraftSend(clientViewer, { draftId, sendAt: new Date(Date.now() + 3_600_000), businessPurpose: PURPOSE })).ok
    ).toBe(false);
    expect((await svc.recordDraftSent(clientViewer, { draftId })).ok).toBe(false);
    expect((await svc.sendProspectDraft(clientViewer, { draftId, channel: "mock", businessPurpose: PURPOSE })).ok).toBe(false);
    expect(await ledgerFor(draftId)).toHaveLength(0);
  });

  describe("contact edits: provenance vouches for one address", () => {
    async function provenanceOf(contactId: string): Promise<string> {
      const [c] = await sql`select provenance from prospect_contacts where id = ${contactId}`;
      return c!.provenance as string;
    }

    it("the operator can explicitly create publicly_sourced and verified contacts", async () => {
      for (const p of ["publicly_sourced", "verified"]) {
        const id = await contactWith(p);
        expect(await provenanceOf(id)).toBe(p);
      }
      // No label → the safe, non-send-ready default.
      const plain = unwrap(
        await svc.addContact(operator, { prospectId: fixture.prospectId, name: "Plain", email: "plain@riverateam.com" })
      ).contactId;
      expect(await provenanceOf(plain)).toBe("manual");
    });

    it("changing the email resets trusted provenance, and the gate then refuses", async () => {
      for (const trusted of ["verified", "publicly_sourced"]) {
        const id = await contactWith(trusted);
        unwrap(await svc.updateContact(operator, { contactId: id, email: `new.${trusted}@riverateam.com` }));
        expect(await provenanceOf(id)).toBe("manual");
        const draftId = await draftTo(id);
        const res = await svc.approveOutreachDraft(operator, { draftId });
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error.message).toMatch(VERIFY);
      }
      const [audit] = await sql`
        select detail from audit_log where action = 'prospect.contact_update'
          and detail->>'emailChanged' = 'true' order by at desc limit 1
      `;
      expect(audit!.detail).toMatchObject({ provenanceBefore: "publicly_sourced", provenanceAfter: "manual" });
    });

    it("an email change after approval is caught at send time", async () => {
      const { draftId, contactId } = await approvedDraft();
      unwrap(await svc.updateContact(operator, { contactId, email: "swapped@riverateam.com" }));
      const res = await svc.sendProspectDraft(operator, { draftId, channel: "mock", businessPurpose: PURPOSE });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.message).toMatch(VERIFY);
    });

    it("an ai_inferred contact whose email is edited stays non-send-ready", async () => {
      const id = await contactWith("ai_inferred");
      unwrap(await svc.updateContact(operator, { contactId: id, email: "edited@riverateam.com" }));
      expect(await provenanceOf(id)).toBe("manual");
    });

    it("changing name, role, notes, phone or primary does not reset provenance; a case-only email edit is the same address", async () => {
      const id = await contactWith("verified");
      unwrap(
        await svc.updateContact(operator, {
          contactId: id,
          name: "Ana M. Rivera",
          role: "Team lead",
          notes: "Source: https://riverateam.com/team",
          phone: "+1 555 0101",
          isPrimary: true,
        })
      );
      expect(await provenanceOf(id)).toBe("verified");
      unwrap(await svc.updateContact(operator, { contactId: id, email: "ANA.VERIFIED@riverateam.com" }));
      expect(await provenanceOf(id)).toBe("verified");
    });

    it("the prospect-level email follows the same rule: a changed address drops its label; other fields keep theirs", async () => {
      const fp = async () =>
        ((await sql`select field_provenance from prospects where id = ${fixture.prospectId}`)[0]!.fieldProvenance as Record<string, string>);
      unwrap(await svc.updateProspect(operator, { prospectId: fixture.prospectId, email: "team@riverateam.com", fieldProvenance: { email: "publicly_sourced" } }));
      expect((await fp()).email).toBe("publicly_sourced");
      unwrap(await svc.updateProspect(operator, { prospectId: fixture.prospectId, teamLeader: "Ana M. Rivera", notes: "lead" }));
      expect((await fp()).email).toBe("publicly_sourced");
      unwrap(await svc.updateProspect(operator, { prospectId: fixture.prospectId, email: "TEAM@riverateam.com" }));
      expect((await fp()).email).toBe("publicly_sourced");
      unwrap(await svc.updateProspect(operator, { prospectId: fixture.prospectId, email: "other@riverateam.com" }));
      expect((await fp()).email).toBe("manual");
    });

    it("re-labelling the new address is an explicit operator act in the same or a later edit", async () => {
      const id = await contactWith("publicly_sourced");
      unwrap(await svc.updateContact(operator, { contactId: id, email: "checked@riverateam.com", provenance: "verified" }));
      expect(await provenanceOf(id)).toBe("verified");
      unwrap(await svc.updateContact(operator, { contactId: id, email: "again@riverateam.com" }));
      expect(await provenanceOf(id)).toBe("manual");
      unwrap(await svc.updateContact(operator, { contactId: id, provenance: "publicly_sourced" }));
      expect(await provenanceOf(id)).toBe("publicly_sourced");
    });
  });

  describe("contact-supply queue reads persisted provenance (spec 148 bug fix)", () => {
    async function identified(name: string): Promise<string> {
      return unwrap(await svc.createProspect(operator, { launchId: fixture.launchId, businessName: name, prospectType: "team" })).prospectId;
    }

    it("recognises a genuinely verified contact without any log entry; keeps unverified ones queued", async () => {
      const { contactSupplyQueue } = await import("@/lib/prospects/enrichment");
      const promoted = await identified("Promoted Team");
      // Exactly what scripts/supply-promote.ts writes after a literal on-page check.
      unwrap(await svc.addContact(operator, { prospectId: promoted, name: "P", email: "p@promoted.com", isPrimary: true, provenance: "publicly_sourced" }));
      unwrap(await svc.addActivityNote(operator, { prospectId: promoted, note: "contact_verified: p@promoted.com appears literally on https://promoted.example/team" }));
      const verified = await identified("Verified Team");
      unwrap(await svc.addContact(operator, { prospectId: verified, name: "V", email: "v@verified.com", provenance: "verified" }));
      const inferred = await identified("Inferred Team");
      unwrap(await svc.addContact(operator, { prospectId: inferred, name: "I", email: "i@inferred.com", provenance: "ai_inferred" }));
      const manual = await identified("Manual Team");
      unwrap(await svc.addContact(operator, { prospectId: manual, name: "M", email: "m@manual.com", provenance: "manual" }));
      const none = await identified("Empty Team");

      const [logKind] = await sql`select count(*)::int as n from prospect_activities where kind = 'contact_verified'`;
      expect(logKind!.n).toBe(0);

      const queue = await contactSupplyQueue();
      const byId = new Map(queue.map((r) => [r.prospectId, r]));
      expect(byId.has(promoted)).toBe(false);
      expect(byId.has(verified)).toBe(false);
      expect(byId.get(inferred)).toMatchObject({ contactStatus: "unverified_email", verificationStatus: "ai_inferred_unverified" });
      expect(byId.get(manual)).toMatchObject({ contactStatus: "unverified_email", verificationStatus: "none" });
      expect(byId.get(none)).toMatchObject({ contactStatus: "no_email", verificationStatus: "none" });
    });

    it("verification is the persisted provenance: upgrading the contact removes the prospect from the queue", async () => {
      const { contactSupplyQueue } = await import("@/lib/prospects/enrichment");
      const p = await identified("Upgrade Team");
      const c = unwrap(await svc.addContact(operator, { prospectId: p, name: "U", email: "u@upgrade.com", provenance: "ai_inferred" })).contactId;
      expect((await contactSupplyQueue()).some((r) => r.prospectId === p)).toBe(true);
      unwrap(await svc.updateContact(operator, { contactId: c, provenance: "publicly_sourced" }));
      expect((await contactSupplyQueue()).some((r) => r.prospectId === p)).toBe(false);
    });
  });
});
