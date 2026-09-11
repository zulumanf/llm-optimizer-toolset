/**
 * Spec 140 — the synthetic first-client purchase path, end to end, over the
 * real database, plus every negative the spec names:
 *
 *   commercial interest → quote (draft) → presented (frozen) → engagement
 *   from the quote → market definition → agreement (draft → sent → signed)
 *   → invoice schedule (3 × $2,500) → installment 1 → ONBOARDING → intake
 *   → exclusivity → baseline → plan → ACTIVE → commercial state.
 *
 * Fixture-only: the launch carries the QA fixture prefix so nothing here
 * enters real metrics; no send, no charge, no real market.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { seedTestActors } from "../helpers/actors";
import { seedProspect, type PipelineModules } from "../helpers/prospect-fixtures";
import { unwrap } from "../helpers/result";

const TEST_URL = process.env.TEST_DATABASE_URL;
const ROOT = join(__dirname, "..", "..");
const operator: CurrentUser = { id: "00000000-0000-4000-8000-000000000401", email: "op@test.local", name: "Operator", role: "operator" };
const admin: CurrentUser = { id: "00000000-0000-4000-8000-000000000001", email: "admin@test.local", name: "Admin", role: "admin" };

describe.skipIf(!TEST_URL)("commercial purchase path dry run (integration)", () => {
  let m: PipelineModules;
  let sql: PipelineModules["sql"];
  let eng: typeof import("@/lib/engagements/service");
  let quotes: typeof import("@/lib/pricing/quotes");
  let agreements: typeof import("@/lib/engagements/agreement");
  let commercial: typeof import("@/lib/engagements/commercial");
  let intake: typeof import("@/lib/engagements/onboarding-intake");
  let tasks: typeof import("@/lib/tasks/service");
  let policy: typeof import("@/lib/pricing/policy");
  let mock: typeof import("@/lib/ai/mock");

  beforeAll(async () => {
    const { sql: s } = await import("@/db/client");
    sql = s;
    m = {
      sql: s,
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
      svc: await import("@/lib/prospects/service"),
    };
    eng = await import("@/lib/engagements/service");
    quotes = await import("@/lib/pricing/quotes");
    agreements = await import("@/lib/engagements/agreement");
    commercial = await import("@/lib/engagements/commercial");
    intake = await import("@/lib/engagements/onboarding-intake");
    tasks = await import("@/lib/tasks/service");
    policy = await import("@/lib/pricing/policy");
    mock = await import("@/lib/ai/mock");
    await sql.unsafe("drop schema public cascade; create schema public;");
    execSync(`npx tsx scripts/migrate.ts up --db "${TEST_URL}"`, { cwd: ROOT, stdio: "pipe" });
    await seedTestActors(sql);
    await sql`update users set role = 'operator' where id = ${operator.id}`;
  });

  beforeEach(async () => {
    await sql.unsafe(
      `truncate audit_log, jobs, engagement_agreements, pricing_quotes, billing_events, task_client_decisions, engagement_context_items,
       engagement_measurements, client_engagements, user_project_access, outreach_sender_identity,
       prospect_activities, prospect_stage_history, outreach_drafts, prospect_benchmarks, prospect_contacts,
       prospects, market_launches, exclusivity_checks, exclusivity_scopes, exclusivity_agreements, markets,
       tasks, evidence, claims, competitors, scores, sources, response_parses, mentions,
       response_citations, brand_candidates, companies, responses, runs,
       prompt_set_versions, prompts, prompt_sets, projects cascade`
    );
    mock.resetMockProvider();
    await sql`insert into outreach_sender_identity (sender_name, company_name, postal_address, reply_to_email, active)
      values ('Francisco', 'Recommended First', 'Brooklyn, NY', 'hello@test.local', true)`;
  });

  afterAll(async () => {
    await sql.end();
  });

  /** ACME REALTY TEST TEAM on a QA-prefixed launch: excluded from metrics by name. */
  async function syntheticProspect() {
    const f = await seedProspect(m, operator, admin, { projectKind: "prospect" });
    await sql`update market_launches set name = 'QA131 sandbox launch' where id = ${f.launchId}`;
    await sql`update markets set name = 'QA131 Sandbox Market' where id = ${f.marketId}`;
    await sql`update prospects set company_id = ${f.subjectCompanyId}, business_name = 'Acme Realty Test Team', website = 'https://acme-test.example', benchmark_project_id = null where id = ${f.prospectId}`;
    await sql`insert into prospect_benchmarks (prospect_id, run_id, company_id, created_by) values (${f.prospectId}, ${f.runId}, ${f.subjectCompanyId}, ${operator.id})`;
    await sql`insert into prospect_contacts (prospect_id, name, email, is_primary, provenance) values (${f.prospectId}, 'Alex Fixture', 'alex@acme-test.example', true, 'manual')`;
    const [acme] = await sql`select id from companies where name = 'Acme'`;
    return { ...f, rivalId: acme!.id as string };
  }

  it("walks a synthetic client from interest to ACTIVE and fails closed at every gate", async () => {
    const f = await syntheticProspect();
    const today = new Date().toISOString().slice(0, 10);
    const active = policy.activePricingPolicy();

    // ------------------------------------------------ Ryan-shaped history stays
    const ryan = unwrap(await m.svc.createProspect(operator, { launchId: f.launchId, businessName: "QA131 Historical Prospect", prospectType: "team" }));
    const v0Quote = await sql.begin((tx) => quotes.recordQuoteFromSend(tx, { prospectId: ryan.prospectId, draftId: null, sendId: null, channel: "email", body: "Pricing: $7,500/month for 3 months, $22,500 total.", sentAt: new Date("2026-09-05T18:00:00Z"), userId: operator.id }));
    expect(v0Quote).toBeTruthy();
    const v0Before = await quotes.quoteById(v0Quote!);
    expect(v0Before!.pricingPolicyVersion).toBe("founder_monthly_7500_v0");
    expect(v0Before!.totalFeeUsd).toBe(22_500);

    // -------------------------------------------------------- quote (draft)
    const q1 = unwrap(await quotes.prepareQuote(operator, { prospectId: f.prospectId }));
    expect(q1.created).toBe(true);
    expect(q1.quote.status).toBe("draft");
    expect(q1.quote.pricingPolicyVersion).toBe(active.version);
    expect(q1.quote.totalFeeUsd).toBe(7_500);
    expect(q1.quote.termDays).toBe(90);
    expect(q1.quote.billing).toEqual({ installments: 3, installmentUsd: 2_500, schedule: ["at signing", "day 30", "day 60"], dueDayOffsets: [0, 30, 60] });
    // idempotent: the same open quote comes back
    expect(unwrap(await quotes.prepareQuote(operator, { prospectId: f.prospectId })).quote.id).toBe(q1.quote.id);
    // a response cannot be recorded on a draft
    expect((await quotes.recordQuoteOutcome(operator, { quoteId: q1.quote.id, status: "accepted" })).ok).toBe(false);
    // commercial state before presentation
    const s0 = await commercial.commercialStateForProspect(f.prospectId);
    expect(s0.stage).toBe("QUOTE_READY");
    expect(s0.offer.label).toBe("$7,500 / 90 days");
    expect(s0.exclusivity.conflict).toBe(false);

    // ---------------------------------------------- presented = frozen
    const presented = unwrap(await quotes.markQuotePresented(operator, { quoteId: q1.quote.id, channel: "email" }));
    expect(presented.quote.status).toBe("presented");
    expect(presented.quote.presentedAt).not.toBeNull();
    await expect(sql`update pricing_quotes set total_fee_usd = 10000 where id = ${q1.quote.id}`).rejects.toThrow(/immutable/);
    await expect(sql`update pricing_quotes set pricing_policy_version = 'founder_monthly_7500_v0' where id = ${q1.quote.id}`).rejects.toThrow(/immutable/);
    await expect(sql`update pricing_quotes set status = 'draft' where id = ${q1.quote.id}`).rejects.toThrow(/never returns to draft/);
    await expect(sql`delete from pricing_quotes where id = ${q1.quote.id}`).rejects.toThrow(/never deleted/);
    expect((await quotes.regenerateDraftQuote(operator, { quoteId: q1.quote.id })).ok).toBe(false);
    expect((await commercial.commercialStateForProspect(f.prospectId)).stage).toBe("QUOTE_PRESENTED");

    // An unpresented draft on another prospect may be regenerated (superseded pointer kept).
    const other = unwrap(await m.svc.createProspect(operator, { launchId: f.launchId, businessName: "QA131 Other Team", prospectType: "team", companyId: f.rivalId }));
    const draft = unwrap(await quotes.prepareQuote(operator, { prospectId: other.prospectId })).quote;
    const regen = unwrap(await quotes.regenerateDraftQuote(operator, { quoteId: draft.id }));
    expect((await quotes.quoteById(draft.id))!.status).toBe("superseded");
    expect((await quotes.quoteById(draft.id))!.supersededBy).toBe(regen.quote.id);

    // ---------------------------------------- engagement from the quote
    const wrongTotal = await eng.signClient(operator, { prospectId: f.prospectId, quoteId: q1.quote.id, startsOn: today, totalValueUsd: 10_000 });
    expect(wrongTotal.ok).toBe(false);
    if (!wrongTotal.ok) expect(wrongTotal.error.message).toMatch(/differ from the presented quote/);
    const signed = unwrap(await eng.signClient(operator, { prospectId: f.prospectId, quoteId: q1.quote.id, startsOn: today, clientLegalName: "Acme Realty Test Team LLC", primaryContactName: "Alex Fixture" }));
    expect(signed.alreadyExisted).toBe(false);
    const e0 = (await eng.getEngagement(signed.engagementId))!;
    expect(e0.quoteId).toBe(q1.quote.id);
    expect(e0.totalValueUsd).toBe(7_500);
    expect(e0.monthlyFeeUsd).toBe(2_500);
    expect(e0.pricingPolicyVersion).toBe(active.version);
    expect(e0.priceOverrideReason).toBeNull();
    expect(e0.clientLegalName).toBe("Acme Realty Test Team LLC");
    expect(e0.endsOn).toBe(new Date(new Date(`${today}T00:00:00Z`).getTime() + 90 * 86_400_000).toISOString().slice(0, 10));
    expect(e0.stage).toBe("signed");
    expect(e0.contractStatus).toBe("draft");
    expect(e0.exclusivityStatus).toBe("reserved");
    expect((await quotes.quoteById(q1.quote.id))!.status).toBe("accepted");
    expect((await quotes.quoteById(q1.quote.id))!.engagementId).toBe(e0.id);
    // duplicate request: same engagement, one territory hold, one row
    const again = unwrap(await eng.signClient(operator, { prospectId: f.prospectId, quoteId: q1.quote.id, startsOn: today }));
    expect(again.alreadyExisted).toBe(true);
    expect(again.engagementId).toBe(e0.id);
    expect((await sql`select count(*)::int as n from client_engagements`)[0]!.n).toBe(1);
    expect((await sql`select count(*)::int as n from exclusivity_agreements where project_id = ${e0.projectId}`)[0]!.n).toBe(1);
    // a second live client in the same market is refused (draft quotes are refused first: present the rival's)
    const rivalDraft = await eng.signClient(operator, { prospectId: other.prospectId, quoteId: regen.quote.id, startsOn: today });
    expect(rivalDraft.ok).toBe(false);
    unwrap(await quotes.markQuotePresented(operator, { quoteId: regen.quote.id }));
    const rival = await eng.signClient(operator, { prospectId: other.prospectId, quoteId: regen.quote.id, startsOn: today });
    expect(rival.ok).toBe(false);
    if (!rival.ok) expect(rival.error.message).toMatch(/One retained client per market/);
    expect((await commercial.commercialStateForProspect(f.prospectId)).stage).toBe("AGREEMENT_READY");

    // ---------------------------------------------------------- agreement
    const noDef = await agreements.prepareAgreement(operator, { engagementId: e0.id });
    expect(noDef.ok).toBe(false);
    unwrap(await eng.confirmMarketDefinition(operator, { engagementId: e0.id, definition: "The QA131 sandbox city limits only; excludes the sandbox metro and county." }));
    const a1 = unwrap(await agreements.prepareAgreement(operator, { engagementId: e0.id }));
    expect(a1.agreement.status).toBe("draft");
    expect(a1.agreement.templateVersion).toBe(agreements.AGREEMENT_TEMPLATE_VERSION);
    expect(a1.agreement.legalReviewStatus).toBe("NOT_REVIEWED");
    expect(a1.agreement.quoteId).toBe(q1.quote.id);
    expect(a1.agreement.contentMd).toContain("**$7,500** for the 90-day engagement, billed in 3 installments");
    expect(a1.agreement.contentMd).toContain("QA131 Sandbox Market");
    expect(a1.agreement.contentMd).toContain("sandbox city limits only");
    expect(a1.agreement.contentMd).toContain("No specific position, ranking or placement");
    expect(a1.agreement.contentMd).toContain("Acme Realty Test Team LLC");
    expect(a1.agreement.contentMd).toContain("Recommended First, Brooklyn, NY");
    // draft regenerates in place
    const a2 = unwrap(await agreements.prepareAgreement(operator, { engagementId: e0.id }));
    expect(a2.regenerated).toBe(true);
    expect((await sql`select count(*)::int as n from engagement_agreements where engagement_id = ${e0.id} and status <> 'void'`)[0]!.n).toBe(1);
    unwrap(await agreements.markAgreementSent(operator, { agreementId: a2.agreement.id }));
    expect((await eng.getEngagement(e0.id))!.contractStatus).toBe("sent");
    expect((await commercial.commercialStateForProspect(f.prospectId)).stage).toBe("AGREEMENT_SENT");
    await expect(sql`update engagement_agreements set content_md = 'rewritten' where id = ${a2.agreement.id}`).rejects.toThrow(/immutable/);
    await expect(sql`delete from engagement_agreements where id = ${a2.agreement.id}`).rejects.toThrow(/never deleted/);
    expect((await agreements.prepareAgreement(operator, { engagementId: e0.id })).ok).toBe(false);
    // unsigned agreement blocks onboarding
    expect((await eng.startOnboarding(operator, { engagementId: e0.id })).ok).toBe(false);
    unwrap(await agreements.recordAgreementSigned(operator, { agreementId: a2.agreement.id, signedRef: "drive://qa131/acme-agreement-signed.pdf" }));
    unwrap(await agreements.recordAgreementSigned(operator, { agreementId: a2.agreement.id, signedRef: "drive://qa131/acme-agreement-signed.pdf" }));
    const e1 = (await eng.getEngagement(e0.id))!;
    expect(e1.contractStatus).toBe("signed");
    expect(e1.contractRef).toBe("drive://qa131/acme-agreement-signed.pdf");
    await expect(sql`update engagement_agreements set status = 'draft' where id = ${a2.agreement.id}`).rejects.toThrow(/stays signed/);
    expect((await agreements.voidAgreement(operator, { agreementId: a2.agreement.id, reason: "trying to regenerate a signed one" })).ok).toBe(false);
    expect((await commercial.commercialStateForProspect(f.prospectId)).stage).toBe("ACTIVATION_PAYMENT_DUE");

    // ------------------------------------------------------- invoices
    const inv = unwrap(await commercial.createInvoiceSchedule(operator, { engagementId: e0.id }));
    expect(inv.created).toBe(3);
    expect(inv.invoices.map((i) => [i.invoiceId, i.amountCents])).toEqual([
      [commercial.installmentInvoiceId(e0.id, 1), 250_000],
      [commercial.installmentInvoiceId(e0.id, 2), 250_000],
      [commercial.installmentInvoiceId(e0.id, 3), 250_000],
    ]);
    expect(inv.invoices.reduce((s, i) => s + i.amountCents, 0)).toBe(750_000);
    const invAgain = unwrap(await commercial.createInvoiceSchedule(operator, { engagementId: e0.id }));
    expect(invAgain.created).toBe(0);
    expect((await sql`select count(*)::int as n from billing_events where kind = 'invoice_created'`)[0]!.n).toBe(3);
    // unpaid activation blocks onboarding
    const unpaid = await eng.startOnboarding(operator, { engagementId: e0.id });
    expect(unpaid.ok).toBe(false);
    if (!unpaid.ok) expect(unpaid.error.message).toMatch(/No payment received/);

    // ------------------------------------------------- installment 1
    const p1 = unwrap(await commercial.recordInstallmentPayment(operator, { engagementId: e0.id, installment: 1, reference: "qa-manual-0001" }));
    expect(p1.payment.status).toBe("PARTIALLY_PAID");
    expect(p1.payment.receivedCents).toBe(250_000);
    expect(p1.payment.balanceCents).toBe(500_000);
    expect(p1.payment.activationPaymentReceived).toBe(true);
    // duplicate event is one event
    const p1dup = unwrap(await commercial.recordInstallmentPayment(operator, { engagementId: e0.id, installment: 1, reference: "qa-manual-0001-retry" }));
    expect(p1dup.billingEventId).toBe(p1.billingEventId);
    expect(p1dup.payment.receivedCents).toBe(250_000);
    expect((await sql`select count(*)::int as n from billing_events where kind = 'payment_received'`)[0]!.n).toBe(1);
    const s1 = await commercial.commercialStateForProspect(f.prospectId);
    expect(s1.stage).toBe("ACTIVATION_PAYMENT_RECEIVED");
    expect(s1.payment!.status).not.toBe("PAID_IN_FULL");
    expect(s1.installments.map((i) => i.paid)).toEqual([true, false, false]);

    // ---------------------------------------------------- onboarding
    unwrap(await eng.startOnboarding(operator, { engagementId: e0.id }));
    expect((await eng.getEngagement(e0.id))!.stage).toBe("onboarding");
    // Exclusivity conflict from another live agreement blocks activation of ours.
    const otherProject = unwrap(await m.projectSvc.createProject(admin, { name: "QA131 Conflicting Client", description: "" }));
    const conflicting = unwrap(await m.exclusivity.createAgreement(admin, { projectId: otherProject.id, startsOn: today, status: "active", scopes: [{ marketId: f.marketId, serviceCategory: "residential brokerage", segment: "luxury" }] }));
    const blockedAct = await eng.activateExclusivity(operator, { engagementId: e0.id });
    expect(blockedAct.ok).toBe(false);
    if (!blockedAct.ok) expect(blockedAct.error.message).toMatch(/Territory conflict/);
    unwrap(await m.exclusivity.terminateAgreement(admin, { agreementId: conflicting.agreementId, terminatedAt: new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10) }));
    unwrap(await eng.activateExclusivity(operator, { engagementId: e0.id }));
    expect((await eng.getEngagement(e0.id))!.exclusivityStatus).toBe("active");
    // Intake: prefilled from the record; required fields enforced; optional never block.
    const pre = (await intake.onboardingPrefill(e0.id))!;
    expect(pre.legalName).toBe("Acme Realty Test Team LLC");
    expect(pre.website).toBe("https://acme-test.example");
    expect(pre.contactEmail).toBe("alex@acme-test.example");
    expect(pre.teamLead).toBe("Ana Rivera");
    expect(pre.marketDefinitionConfirmed).toBe(true);
    expect(pre.prefilled).toEqual(expect.arrayContaining(["legalName", "website", "contactEmail", "marketDefinition"]));
    const missing = await intake.completeOnboardingIntake(operator, { engagementId: e0.id, legalName: pre.legalName, brandName: pre.brandName, website: pre.website, primaryContactName: pre.primaryContactName, contactEmail: pre.contactEmail, marketDefinition: pre.marketDefinition, priorities: [], websiteControl: "client_applies_changes" });
    expect(missing.ok).toBe(false);
    const done = unwrap(await intake.completeOnboardingIntake(operator, { engagementId: e0.id, legalName: pre.legalName, brandName: pre.brandName, entityType: pre.entityType, teamLead: pre.teamLead, website: pre.website, primaryContactName: pre.primaryContactName, contactEmail: pre.contactEmail, marketDefinition: pre.marketDefinition, priorities: ["Sandbox Heights", "sellers"], websiteControl: "client_applies_changes", terminology: ["luxury"] }));
    expect(done.itemsCreated).toBeGreaterThanOrEqual(5);
    const doneAgain = unwrap(await intake.completeOnboardingIntake(operator, { engagementId: e0.id, legalName: pre.legalName, brandName: pre.brandName, entityType: pre.entityType, teamLead: pre.teamLead, website: pre.website, primaryContactName: pre.primaryContactName, contactEmail: pre.contactEmail, marketDefinition: pre.marketDefinition, priorities: ["Sandbox Heights", "sellers"], websiteControl: "client_applies_changes", terminology: ["luxury"] }));
    expect(doneAgain.itemsCreated).toBe(0);
    // Not active yet: baseline + plan still missing.
    expect((await eng.markActive(operator, { engagementId: e0.id })).ok).toBe(false);
    const frozen = unwrap(await eng.freezeBaseline(operator, { engagementId: e0.id, provider: "mock" }));
    const w = unwrap(await tasks.suggestTask(operator, { projectId: e0.projectId, title: "Align identity on owned pages", evidence: [{ kind: "response", refId: frozen.snapshot.questions[0]!.responseIds[0]!, note: "baseline" }] }));
    expect(w.taskId).toBeTruthy();
    unwrap(await eng.markActive(operator, { engagementId: e0.id }));
    const sA = await commercial.commercialStateForProspect(f.prospectId);
    expect(sA.stage).toBe("ACTIVE");
    expect(sA.engagementStage).toBe("active");
    expect(sA.payment!.status).toBe("PARTIALLY_PAID");
    expect(sA.payment!.balanceCents).toBe(500_000);
    expect(sA.offer.source).toBe("engagement");
    expect(sA.agreement!.status).toBe("signed");
    expect(sA.exclusivity.status).toBe("active");
    expect(sA.exclusivity.conflict).toBe(false);
    // Duplicate activation: refused, nothing duplicated.
    expect((await eng.markActive(operator, { engagementId: e0.id })).ok).toBe(false);
    expect((await sql`select count(*)::int as n from client_engagements`)[0]!.n).toBe(1);
    expect((await sql`select count(*)::int as n from exclusivity_agreements where project_id = ${e0.projectId}`)[0]!.n).toBe(1);
    // Installments 2 and 3 complete the contract exactly.
    unwrap(await commercial.recordInstallmentPayment(operator, { engagementId: e0.id, installment: 2 }));
    const p3 = unwrap(await commercial.recordInstallmentPayment(operator, { engagementId: e0.id, installment: 3 }));
    expect(p3.payment.status).toBe("PAID_IN_FULL");
    expect(p3.payment.receivedCents).toBe(750_000);
    expect(p3.payment.balanceCents).toBe(0);

    // ------------------------------------------------ safety and history
    // History untouched: the v0 quote is exactly what it was; its terms are immutable.
    const v0After = await quotes.quoteById(v0Quote!);
    expect(v0After).toEqual(v0Before);
    await expect(sql`update pricing_quotes set total_fee_usd = 7500 where id = ${v0Quote}`).rejects.toThrow(/immutable/);
    // The engagement's economics are its own rows, not a live policy read.
    const [row] = await sql`select total_value_usd, monthly_fee_usd, pricing_policy_version from client_engagements where id = ${e0.id}`;
    expect([Number(row!.totalValueUsd), Number(row!.monthlyFeeUsd), row!.pricingPolicyVersion]).toEqual([7_500, 2_500, active.version]);
    // Fixture never enters real metrics.
    const learning = await quotes.pricingLearning();
    expect(learning.offersPresented).toBe(0);
    expect(learning.clientsWon).toBe(0);
    expect(learning.paymentsReceivedUsd).toBe(0);
    // No outbound send, no external payment, no real market.
    expect((await sql`select count(*)::int as n from prospect_outreach_sends`)[0]!.n).toBe(0);
    expect((await sql`select count(*)::int as n from billing_events where external_invoice_id not like 'ENG-%'`)[0]!.n).toBe(0);
    expect((await sql`select count(*)::int as n from markets where name not like 'QA131%'`)[0]!.n).toBe(0);
    // Audit trail reconstructs the path.
    const actions = (await sql`select action from audit_log where entity_id = ${e0.id} or entity_id = ${q1.quote.id}`).map((r) => r.action as string);
    for (const a of ["pricing.quote_prepared", "pricing.quote_presented", "engagement.signed", "engagement.agreement_prepared", "engagement.agreement_sent", "engagement.agreement_signed", "engagement.invoice_schedule", "engagement.onboarding_intake", "engagement.stage"]) {
      expect(actions).toContain(a);
    }
  });
});
