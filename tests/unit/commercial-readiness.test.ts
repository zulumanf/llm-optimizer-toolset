/**
 * Spec 140 — pricing, agreement, payment, market and metrics semantics that
 * hold without a database. Numbers reference the spec's test matrix.
 */
import { describe, expect, it } from "vitest";
import {
  activePricingPolicy,
  assertQuotablePolicy,
  installmentSchedule,
  policyMoney,
  pricingPolicy,
  pricingReplyLines,
  PRICING_POLICIES,
  runRate,
  usdToCents,
  validatePolicy,
} from "@/lib/pricing/policy";
import { billingSnapshot } from "@/lib/pricing/quotes";
import { activationPaid, commercialGate, onboardingChecklist } from "@/lib/engagements/rules";
import {
  COMMERCIAL_NEXT_ACTION,
  deriveCommercialStage,
  installmentInvoiceId,
  paymentState,
} from "@/lib/engagements/commercial";
import {
  AGREEMENT_CLAUSES,
  AGREEMENT_TEMPLATE_VERSION,
  TEMPLATE_LEGAL_REVIEW_STATUS,
  agreementHash,
  buildAgreementSnapshot,
  renderAgreement,
} from "@/lib/engagements/agreement";
import { intakeMissing, INTAKE_REQUIRED_FIELDS } from "@/lib/engagements/onboarding-intake";
import { offerSection } from "@/lib/prospects/audit-mismatch";
import type { EngagementRow } from "@/lib/engagements/service";

/** The one place the expected current offer is written as literals. */
const EXPECTED = { totalCents: 750_000, termDays: 90, installments: 3, installmentCents: 250_000 } as const;

describe("current offer — canonical policy (1-7, 16)", () => {
  const p = activePricingPolicy();
  it("resolves to exactly one active policy with the expected economics in integer cents", () => {
    expect(PRICING_POLICIES.filter((x) => x.status === "active")).toHaveLength(1);
    expect(p.version).toBe("first_client_90d_v1");
    expect(policyMoney(p)).toEqual(EXPECTED);
  });
  it("installments sum exactly to the total (integer arithmetic)", () => {
    const m = policyMoney(p);
    expect(m.installmentCents * m.installments).toBe(m.totalCents);
    expect(Number.isInteger(m.totalCents)).toBe(true);
  });
  it("every policy entry validates structurally (schedule per installment, sums exact)", () => {
    for (const x of PRICING_POLICIES) expect(() => validatePolicy(x)).not.toThrow();
  });
  it("usdToCents refuses sub-cent amounts and never floats", () => {
    expect(usdToCents(2_500)).toBe(250_000);
    expect(usdToCents(0.1 + 0.2)).toBe(30);
    expect(() => usdToCents(0.001)).toThrow(/exact number of cents/);
  });
  it("pricing reply states the total first and the monthly billing after — never per month as the price", () => {
    const lines = pricingReplyLines(p);
    expect(lines[0]).toBe("The 90-day engagement is $7,500.");
    expect(lines[2]).toBe("We bill it as $2,500 per month over the 90 days.");
    expect(lines.join(" ")).not.toMatch(/\$7,500\/month/);
  });
});

describe("installment schedule (17, 23, 26, 39)", () => {
  it("3 × $2,500 at day 0 / 30 / 60 from the start date, exact total", () => {
    const s = installmentSchedule(activePricingPolicy().billing, "2026-10-01");
    expect(s.map((i) => [i.n, i.amountCents, i.dueOn])).toEqual([
      [1, 250_000, "2026-10-01"],
      [2, 250_000, "2026-10-31"],
      [3, 250_000, "2026-11-30"],
    ]);
    expect(s.reduce((t, i) => t + i.amountCents, 0)).toBe(EXPECTED.totalCents);
  });
  it("invoice ids are deterministic per engagement and installment", () => {
    expect(installmentInvoiceId("0f9c1a2b-0000-4000-8000-000000000000", 2)).toBe("ENG-0F9C1A2B-2");
  });
});

describe("historical policy — Ryan (8-11, 49)", () => {
  const v0 = pricingPolicy("founder_monthly_7500_v0")!;
  it("remains $7,500/month × 3 = $22,500 and is not quotable", () => {
    expect(policyMoney(v0)).toEqual({ totalCents: 2_250_000, termDays: 90, installments: 3, installmentCents: 750_000 });
    expect(v0.status).toBe("retired");
    expect(() => assertQuotablePolicy(v0.version)).toThrow(/not active/);
  });
  it("a new quote's billing snapshot comes from the active policy, not from v0", () => {
    expect(billingSnapshot(activePricingPolicy())).toEqual({ installments: 3, installmentUsd: 2_500, schedule: ["at signing", "day 30", "day 60"], dueDayOffsets: [0, 30, 60] });
    expect(billingSnapshot(v0).installmentUsd).toBe(7_500);
  });
});

describe("payment semantics (24, 25, 28, 47, 48)", () => {
  const base = { contractTotalCents: EXPECTED.totalCents, activationPaymentCents: EXPECTED.installmentCents, invoicedCents: EXPECTED.totalCents, overdueCount: 0 };
  it("first $2,500 leaves $5,000 and is PARTIALLY_PAID, never PAID_IN_FULL", () => {
    const s = paymentState({ ...base, receivedCents: 250_000 });
    expect(s.status).toBe("PARTIALLY_PAID");
    expect(s.balanceCents).toBe(500_000);
    expect(s.activationPaymentReceived).toBe(true);
  });
  it("all three installments = PAID_IN_FULL with zero balance; nothing = UNPAID; overdue wins over partial", () => {
    expect(paymentState({ ...base, receivedCents: 750_000 }).status).toBe("PAID_IN_FULL");
    expect(paymentState({ ...base, receivedCents: 0 }).status).toBe("UNPAID");
    expect(paymentState({ ...base, receivedCents: 250_000, overdueCount: 1 }).status).toBe("OVERDUE");
  });
  it("a partial first installment does not satisfy activation; a failed (unrecorded) payment blocks the gate", () => {
    expect(activationPaid({ activationPaymentCents: 250_000, paymentsReceivedCents: 100_000, activationOverrideReason: null })).toBe(false);
    const g = commercialGate({ contractStatus: "signed", activationPaymentCents: 250_000, paymentsReceivedCents: 100_000, activationOverrideReason: null });
    expect(g.ready).toBe(false);
    expect(g.reasons[0]).toMatch(/Activation payment incomplete/);
    expect(commercialGate({ contractStatus: "signed", activationPaymentCents: 250_000, paymentsReceivedCents: 250_000, activationOverrideReason: null }).ready).toBe(true);
    expect(commercialGate({ contractStatus: "sent", activationPaymentCents: 250_000, paymentsReceivedCents: 750_000, activationOverrideReason: null }).ready).toBe(false);
  });
  it("run rate is labelled ANNUALIZED RUN RATE and never presented as contracted annual revenue", () => {
    const r = runRate(activePricingPolicy());
    expect(r.monthlyEquivalentUsd).toBe(2_500);
    expect(r.annualizedRunRateUsd).toBe(30_000);
    expect(r.annualizedLabel).toBe("ANNUALIZED RUN RATE");
    expect(r.contractedTotalUsd).toBe(7_500);
    expect(COMMERCIAL_NEXT_ACTION.ACTIVE).not.toMatch(/annual/i);
  });
  it("checklist payment line follows the activation rule", () => {
    const items = onboardingChecklist({ contractStatus: "signed", activationPaymentCents: 250_000, paymentsReceivedCents: 100_000, activationOverrideReason: null, subjectLinked: true, primaryContactNamed: true, marketDefinitionConfirmed: true, exclusivityStatus: "active", exclusivityConflictFree: true, priorityItems: 1, assetItems: 1, accessRequestedOpen: 0, baselineFrozen: true, planItems: 1 });
    expect(items.find((i) => i.key === "payment")!.done).toBe(false);
  });
});

describe("commercial stage derivation (40)", () => {
  const none = { quoteStatus: null, engagementStage: null, contractStatus: null, agreementStatus: null, activationPaymentReceived: false, activationOverridden: false } as const;
  it("walks interest → quote → agreement → payment → onboarding → active", () => {
    expect(deriveCommercialStage(none)).toBe("COMMERCIAL_INTEREST");
    expect(deriveCommercialStage({ ...none, quoteStatus: "draft" })).toBe("QUOTE_READY");
    expect(deriveCommercialStage({ ...none, quoteStatus: "presented" })).toBe("QUOTE_PRESENTED");
    expect(deriveCommercialStage({ ...none, quoteStatus: "accepted" })).toBe("QUOTE_ACCEPTED");
    expect(deriveCommercialStage({ ...none, quoteStatus: "declined" })).toBe("DECLINED");
    expect(deriveCommercialStage({ ...none, quoteStatus: "accepted", engagementStage: "signed", contractStatus: "draft" })).toBe("AGREEMENT_READY");
    expect(deriveCommercialStage({ ...none, quoteStatus: "accepted", engagementStage: "signed", contractStatus: "sent", agreementStatus: "sent" })).toBe("AGREEMENT_SENT");
    expect(deriveCommercialStage({ ...none, quoteStatus: "accepted", engagementStage: "signed", contractStatus: "signed", agreementStatus: "signed" })).toBe("ACTIVATION_PAYMENT_DUE");
    expect(deriveCommercialStage({ ...none, quoteStatus: "accepted", engagementStage: "signed", contractStatus: "signed", agreementStatus: "signed", activationPaymentReceived: true })).toBe("ACTIVATION_PAYMENT_RECEIVED");
    expect(deriveCommercialStage({ ...none, engagementStage: "onboarding", contractStatus: "signed" })).toBe("ONBOARDING");
    expect(deriveCommercialStage({ ...none, engagementStage: "active", contractStatus: "signed" })).toBe("ACTIVE");
    expect(deriveCommercialStage({ ...none, engagementStage: "churned", contractStatus: "signed" })).toBe("LOST");
  });
});

function engagementFixture(over: Partial<EngagementRow> = {}): EngagementRow {
  return {
    id: "11111111-1111-4111-8111-111111111111", projectId: "p", prospectId: "x", marketId: "m", marketName: "QA131 Sandbox Market",
    exclusivityAgreementId: null, exclusivityStatus: "reserved", previousEngagementId: null, primaryContactId: null, primaryContactName: "Alex Fixture",
    ownerId: null, startsOn: "2026-10-01", endsOn: "2026-12-30", monthlyFeeUsd: 2_500, totalValueUsd: 7_500, billingCadence: "monthly",
    paymentTerms: "", pricingPolicyVersion: "first_client_90d_v1", defaultTotalValueUsd: 7_500, priceOverrideReason: null,
    contractStatus: "draft", contractRef: null, contractSignedAt: null, marketDefinition: "The QA131 sandbox city limits only; excludes the sandbox metro.",
    marketDefinitionConfirmedAt: new Date("2026-10-01T00:00:00Z"), scopeSummary: "Diagnosis, implementation, monitoring, remeasurement.", scopeExclusions: "No SEO.",
    stage: "signed", activationOverrideReason: null, renewalStatus: "not_due", renewalReviewOn: "2026-12-09", caseStudyPermission: false, testimonialPermission: false,
    logoPermission: false, anonymizedDataPermission: false, closedAt: null, closeReason: null, cooldownUntil: null, quoteId: "22222222-2222-4222-8222-222222222222", clientLegalName: "Acme Realty Test Team LLC",
    ...over,
  };
}

describe("agreement artifact (14-22)", () => {
  const snapshot = buildAgreementSnapshot({
    engagement: engagementFixture(),
    quote: { id: "22222222-2222-4222-8222-222222222222", presentedAt: new Date("2026-09-30T12:00:00Z"), billing: billingSnapshot(activePricingPolicy()), scopeVersion: "scope_90d_market_implementation_v1" },
    provider: { legalName: "Recommended First", postalAddress: "Brooklyn, NY" },
    brandName: "Acme Realty Test Team",
    now: new Date("2026-10-01T00:00:00Z"),
  });
  const md = renderAgreement(snapshot);
  it("binds to the quote and the template version, and records NOT_REVIEWED", () => {
    expect(snapshot.commercial.quoteId).toBe("22222222-2222-4222-8222-222222222222");
    expect(snapshot.templateVersion).toBe(AGREEMENT_TEMPLATE_VERSION);
    expect(snapshot.legalReviewStatus).toBe("NOT_REVIEWED");
    expect(TEMPLATE_LEGAL_REVIEW_STATUS).toBe("NOT_REVIEWED");
    expect(md).toContain("Legal review: NOT_REVIEWED");
  });
  it("states $7,500 total, 90 days, 3 × $2,500 with dates, the scope, the market and no-guarantee language", () => {
    expect(md).toContain("**$7,500** for the 90-day engagement, billed in 3 installments");
    expect(md).toContain("Installment 1: $2,500 — at signing (due 2026-10-01)");
    expect(md).toContain("Installment 3: $2,500 — day 60 (due 2026-11-30)");
    expect(md).toContain("Term: 90 days, effective 2026-10-01 through 2026-12-30");
    expect(md).toContain("Market: **QA131 Sandbox Market**. Boundary: The QA131 sandbox city limits only");
    for (const inc of activePricingPolicy().includes) expect(md).toContain(inc);
    for (const g of AGREEMENT_CLAUSES.noGuarantee) expect(md).toContain(g);
    expect(md).toContain("probabilistic");
    expect(md).toContain("**Client:** Acme Realty Test Team LLC (Acme Realty Test Team)");
    expect(md).toContain("**Provider:** Recommended First, Brooklyn, NY");
    expect(md).not.toMatch(/\$7,500\/month|\$22,500/);
  });
  it("is deterministic: same snapshot → same hash", () => {
    expect(agreementHash(renderAgreement(snapshot))).toBe(agreementHash(md));
  });
  it("a pre-quote engagement renders from its own snapshot (one upfront installment when no policy matches)", () => {
    const s2 = buildAgreementSnapshot({ engagement: engagementFixture({ quoteId: null, pricingPolicyVersion: null, totalValueUsd: 9_000, monthlyFeeUsd: 9_000 }), quote: null, provider: { legalName: "Recommended First", postalAddress: "" }, brandName: "X", now: new Date() });
    expect(s2.commercial.installments).toHaveLength(1);
    expect(s2.commercial.installments[0]!.amountUsd).toBe(9_000);
  });
});

describe("onboarding intake (42, 43)", () => {
  it("required fields are enforced; optional ones never block", () => {
    expect(intakeMissing({})).toEqual([...INTAKE_REQUIRED_FIELDS]);
    expect(intakeMissing({ legalName: "A", brandName: "A", primaryContactName: "B", contactEmail: "b@x.test", website: "https://x.test", marketDefinition: "x".repeat(20), priorities: ["Downtown"], websiteControl: "client_can_delegate" })).toEqual([]);
  });
});

describe("report pricing (12, 13)", () => {
  it("the offer section is built from the policy it is given — the active one by default, v0 when asked for history", () => {
    const now = offerSection();
    expect(now.pricingPolicyVersion).toBe("first_client_90d_v1");
    expect(JSON.stringify(now)).toContain("$7,500");
    expect(JSON.stringify(now)).not.toContain("$22,500");
    const v0 = offerSection(pricingPolicy("founder_monthly_7500_v0")!);
    expect(JSON.stringify(v0)).toContain("$22,500");
  });
});
