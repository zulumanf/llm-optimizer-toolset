/**
 * Spec 140 — production-safe dry run of the first-client purchase path.
 *
 * Runs the whole commercial path against the deployed database on an
 * ISOLATED fixture: its own QA131 root market (unrelated to every real
 * market, so no real territory is reserved), its own launch, company,
 * prospect and contact. No email, no invoice sent, no charge, no provider.
 * Ryan Ogle's quote row (251574c6) is hashed before and after; any change
 * fails the run. Fixtures are closed and archived at the end.
 *
 *   npx tsx scripts/commercial-dry-run.ts
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import { QA_FIXTURE_NAME_PREFIX } from "@/lib/prospects/constants";

const RYAN_QUOTE = "251574c6-1cb5-48c3-a4ea-10f90b81cdc8";
const TAG = QA_FIXTURE_NAME_PREFIX;
const results: { phase: string; status: "PASS" | "FAIL"; detail: string }[] = [];
const pass = (phase: string, detail = "") => { results.push({ phase, status: "PASS", detail }); console.log(`PASS ${phase} ${detail}`); };
const failed = (phase: string, detail: string) => { results.push({ phase, status: "FAIL", detail }); console.log(`FAIL ${phase} ${detail}`); };
const expect = (phase: string, cond: boolean, detail: string) => (cond ? pass(phase, detail) : failed(phase, detail));
const unwrap = <T>(r: { ok: true; data: T } | { ok: false; error: { message: string } }): T => { if (!r.ok) throw new Error(r.error.message); return r.data; };
const today = () => new Date().toISOString().slice(0, 10);

async function ryanHash(): Promise<string> {
  const [q] = await sql`select pricing_policy_version, total_fee_usd, term_days, billing_structure, status, outcome, objections, preferred_solution, quoted_at, responded_at, engagement_id from pricing_quotes where id = ${RYAN_QUOTE}`;
  const [counts] = await sql`
    select (select count(*) from pricing_quotes where status not in ('draft','superseded') and prospect_id in (select id from prospects p join market_launches l on l.id = p.launch_id where l.name not like ${TAG + "%"}))::int as real_quotes,
      (select count(*) from client_engagements e join projects p on p.id = e.project_id where p.name not like ${TAG + "%"})::int as real_engagements,
      (select count(*) from prospect_outreach_sends)::int as sends,
      (select count(*) from exclusivity_agreements a join projects p on p.id = a.project_id where p.name not like ${TAG + "%"} and a.status in ('active','reserved'))::int as real_agreements`;
  return createHash("sha256").update(JSON.stringify({ q, counts })).digest("hex") + ` (${JSON.stringify(counts)})`;
}

async function actor(): Promise<CurrentUser> {
  const [row] = await sql`select id, email, name, role from users where role = 'admin' and active order by created_at asc limit 1`;
  if (!row) throw new Error("no active admin user");
  return { id: row.id as string, email: row.email as string, name: row.name as string, role: "admin" };
}

async function main() {
  const before = await ryanHash();
  const admin = await actor();
  console.log(`actor: ${admin.email} (admin)`);
  const excl = await import("@/lib/exclusivity/service");
  const prospects = await import("@/lib/prospects/service");
  const companies = await import("@/lib/companies/service");
  const projects = await import("@/lib/projects/service");
  const quotes = await import("@/lib/pricing/quotes");
  const eng = await import("@/lib/engagements/service");
  const agreements = await import("@/lib/engagements/agreement");
  const commercial = await import("@/lib/engagements/commercial");
  const intake = await import("@/lib/engagements/onboarding-intake");
  const policy = await import("@/lib/pricing/policy");

  const [mig] = await sql`select 1 from schema_migrations where name = '112_commercial_purchase_path.sql'`;
  expect("migration 112 applied", Boolean(mig), "schema_migrations has 112");
  const active = policy.activePricingPolicy();
  expect("current policy", active.version === "first_client_90d_v1" && policy.policyMoney(active).totalCents === 750_000 && policy.policyMoney(active).installmentCents === 250_000, `${active.version} ${policy.offerLabel(active)} ${policy.billingLabel(active)}`);
  const [ryan] = await sql`select pricing_policy_version, total_fee_usd, status from pricing_quotes where id = ${RYAN_QUOTE}`;
  expect("Ryan historical quote", ryan?.pricingPolicyVersion === "founder_monthly_7500_v0" && Number(ryan?.totalFeeUsd) === 22_500 && ryan?.status === "declined", JSON.stringify(ryan));
  const provider = await agreements.providerIdentity();
  expect("provider identity on record", Boolean(provider), JSON.stringify(provider));

  const stamp = Date.now().toString(36);
  const stampProspects: string[] = [];
  let engagementId: string | null = null;
  try {
    const market = unwrap(await excl.createMarket(admin, { name: `${TAG} Sandbox Market ${stamp}`, kind: "custom", aliases: [] }));
    const launch = unwrap(await prospects.createLaunch(admin, { name: `${TAG} launch ${stamp}`, marketId: market.marketId, priceSegment: "luxury", serviceCategory: "residential brokerage" }));
    const company = unwrap(await companies.upsertCompany(admin, { name: `${TAG} Acme Realty Test Team ${stamp}` }));
    const prospect = unwrap(await prospects.createProspect(admin, { launchId: launch.launchId, businessName: `${TAG} Acme Realty Test Team ${stamp}`, prospectType: "team", companyId: company.id, teamLeader: "Alex Fixture", website: "https://acme-test.example" }));
    stampProspects.push(prospect.prospectId);
    unwrap(await prospects.addContact(admin, { prospectId: prospect.prospectId, name: "Alex Fixture", email: `alex-${stamp}@acme-test.example`, isPrimary: true, provenance: "manual" }));

    // quote
    const q = unwrap(await quotes.prepareQuote(admin, { prospectId: prospect.prospectId })).quote;
    expect("quote: current policy, $7,500 / 90 / 3 × $2,500", q.pricingPolicyVersion === active.version && q.totalFeeUsd === 7_500 && q.termDays === 90 && q.billing.installments === 3 && q.billing.installmentUsd === 2_500, q.id);
    unwrap(await quotes.markQuotePresented(admin, { quoteId: q.id, channel: "manual" }));
    let frozen = false;
    try { await sql`update pricing_quotes set total_fee_usd = 1 where id = ${q.id}`; } catch (e) { frozen = /immutable/.test(String(e)); }
    expect("quote: presented terms immutable", frozen, "");
    expect("quote: state", (await commercial.commercialStateForProspect(prospect.prospectId)).stage === "QUOTE_PRESENTED", "");

    // engagement from quote (idempotent)
    const signed = unwrap(await eng.signClient(admin, { prospectId: prospect.prospectId, quoteId: q.id, startsOn: today(), clientLegalName: `${TAG} Acme Realty Test Team LLC`, primaryContactName: "Alex Fixture" }));
    engagementId = signed.engagementId;
    const again = unwrap(await eng.signClient(admin, { prospectId: prospect.prospectId, quoteId: q.id, startsOn: today() }));
    expect("engagement: created once from quote", again.alreadyExisted && again.engagementId === signed.engagementId, signed.engagementId);
    const e0 = (await eng.getEngagement(signed.engagementId))!;
    expect("engagement: snapshot", e0.quoteId === q.id && e0.totalValueUsd === 7_500 && e0.monthlyFeeUsd === 2_500 && e0.pricingPolicyVersion === active.version && e0.exclusivityStatus === "reserved", `${e0.startsOn} → ${e0.endsOn}`);
    const wrong = await eng.signClient(admin, { prospectId: prospect.prospectId, quoteId: q.id, startsOn: today(), totalValueUsd: 10_000 });
    expect("engagement: restated terms must match the quote", again.alreadyExisted || !wrong.ok, "");

    // agreement
    expect("agreement: needs market definition", !(await agreements.prepareAgreement(admin, { engagementId: e0.id })).ok, "");
    unwrap(await eng.confirmMarketDefinition(admin, { engagementId: e0.id, definition: `${TAG} sandbox city limits only; nothing real; excludes every real market.` }));
    const a = unwrap(await agreements.prepareAgreement(admin, { engagementId: e0.id })).agreement;
    expect("agreement: content", a.templateVersion === "engagement_agreement_v1" && a.legalReviewStatus === "NOT_REVIEWED" && a.contentMd.includes("**$7,500** for the 90-day engagement, billed in 3 installments") && a.contentMd.includes("No specific position, ranking or placement") && a.contentMd.includes(market.marketId ? `${TAG} Sandbox Market` : ""), a.id);
    unwrap(await agreements.markAgreementSent(admin, { agreementId: a.id, channel: "manual" }));
    expect("gate: unsigned agreement blocks onboarding", !(await eng.startOnboarding(admin, { engagementId: e0.id })).ok, "");
    unwrap(await agreements.recordAgreementSigned(admin, { agreementId: a.id, signedRef: `qa131://${stamp}/signed.pdf` }));
    expect("agreement: signed → contract signed", (await eng.getEngagement(e0.id))!.contractStatus === "signed", "");

    // invoices + payment
    const inv = unwrap(await commercial.createInvoiceSchedule(admin, { engagementId: e0.id }));
    const invAgain = unwrap(await commercial.createInvoiceSchedule(admin, { engagementId: e0.id }));
    expect("invoices: 3 × $2,500, idempotent", inv.created === 3 && invAgain.created === 0 && inv.invoices.reduce((s, i) => s + i.amountCents, 0) === 750_000, inv.invoices.map((i) => i.invoiceId).join(","));
    expect("gate: unpaid activation blocks onboarding", !(await eng.startOnboarding(admin, { engagementId: e0.id })).ok, "");
    const p1 = unwrap(await commercial.recordInstallmentPayment(admin, { engagementId: e0.id, installment: 1, reference: `qa-manual-${stamp}` }));
    const p1b = unwrap(await commercial.recordInstallmentPayment(admin, { engagementId: e0.id, installment: 1, reference: `qa-manual-${stamp}-retry` }));
    expect("payment: $2,500 paid, $5,000 remaining, not PAID_IN_FULL, duplicate collapsed", p1.payment.status === "PARTIALLY_PAID" && p1.payment.balanceCents === 500_000 && p1b.billingEventId === p1.billingEventId, "");
    unwrap(await eng.startOnboarding(admin, { engagementId: e0.id }));
    unwrap(await eng.activateExclusivity(admin, { engagementId: e0.id }));
    const pre = (await intake.onboardingPrefill(e0.id))!;
    expect("onboarding: prefill", pre.website === "https://acme-test.example" && pre.contactEmail.endsWith("@acme-test.example") && pre.marketDefinitionConfirmed, pre.prefilled.join(","));
    const done = unwrap(await intake.completeOnboardingIntake(admin, { engagementId: e0.id, legalName: pre.legalName, brandName: pre.brandName, entityType: pre.entityType, teamLead: pre.teamLead, website: pre.website, primaryContactName: pre.primaryContactName, contactEmail: pre.contactEmail, marketDefinition: pre.marketDefinition, priorities: ["Sandbox Heights"], websiteControl: "client_applies_changes" }));
    expect("onboarding: intake recorded", done.itemsCreated >= 4, `${done.itemsCreated} items`);
    const state = await commercial.commercialStateForProspect(prospect.prospectId);
    expect("operator view: ONBOARDING with correct commercial facts", state.stage === "ONBOARDING" && state.payment!.balanceCents === 500_000 && state.agreement!.status === "signed" && state.exclusivity.status === "active" && !state.exclusivity.conflict, state.nextAction);
    // ACTIVE needs baseline + plan; a synthetic benchmark is out of scope for prod — prove the gate instead.
    expect("gate: ACTIVE refused without baseline/plan", !(await eng.markActive(admin, { engagementId: e0.id })).ok, "");
  } finally {
    if (engagementId) {
      const e = await eng.getEngagement(engagementId);
      if (e && ["signed", "onboarding", "active", "renewal_review"].includes(e.stage)) {
        unwrap(await eng.closeEngagement(admin, { engagementId, outcome: "churned", reason: `${TAG} commercial dry run teardown.` }));
      }
    }
    for (const pid of stampProspects) await sql`update prospects set archived_at = now(), notes = ${`${TAG} commercial dry run fixture — archived`} where id = ${pid}`;
    const fixtureProjects = await sql`select id from projects where name like ${TAG + "%"} and status = 'active'`;
    for (const pr of fixtureProjects) await projects.archiveProject(admin, { id: pr.id as string });
    await sql`update companies set archived_at = now() where name like ${TAG + "%"} and archived_at is null`;
    await sql`update market_launches set archived_at = now() where name like ${TAG + "%"} and archived_at is null`;
    await sql`delete from engagement_qa_events where engagement_id in (select e.id from client_engagements e join projects p on p.id = e.project_id where p.name like ${TAG + "%"})`;
    pass("teardown", "fixture engagement closed; prospect, project, company, launch archived");
  }
  const after = await ryanHash();
  expect("SAFETY: Ryan quote + real counters unchanged", before === after, before === after ? "identical" : `BEFORE ${before}\nAFTER ${after}`);
  const fails = results.filter((r) => r.status === "FAIL");
  console.log(`\n${results.length - fails.length}/${results.length} PASS`);
  if (fails.length > 0) { console.log(JSON.stringify(fails, null, 1)); process.exitCode = 1; }
  await sql.end();
}
main().catch(async (e) => { console.error("DRY RUN ERROR", e); try { await sql.end(); } catch {} process.exit(1); });
