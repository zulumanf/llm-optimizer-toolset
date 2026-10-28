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
  contractTotalCents,
  deriveCommercialStage,
  installmentInvoiceId,
  paymentState,
} from "@/lib/engagements/commercial";
import {
  AGREEMENT_CLAUSES,
  AGREEMENT_TEMPLATE_V1,
  AGREEMENT_TEMPLATE_V2,
  AGREEMENT_TEMPLATE_VERSION,
  AGREEMENT_V2_CLAUSES,
  TEMPLATE_LEGAL_REVIEW_STATUS,
  agreementHash,
  buildAgreementSnapshot,
  renderAgreement,
} from "@/lib/engagements/agreement";
import { intakeMissing, INTAKE_REQUIRED_FIELDS } from "@/lib/engagements/onboarding-intake";
import { offerSection } from "@/lib/prospects/audit-mismatch";
import type { EngagementRow } from "@/lib/engagements/service";
import { performanceInvoiceId, type PerformanceTarget } from "@/lib/engagements/performance";

/** sha256 of the spec 140 (v1) renderer's output over the v1 fixture below — pinned before spec 152 touched the file. */
const V1_GOLDEN_HASH = "becac77fa70fe26bfb28147df314c5e69af26912e9d3cfbe97c56d942c72e0b4";

/** The one place the expected current offer is written as literals (spec 152). */
const EXPECTED = { totalCents: 100_000, termDays: 90, installments: 1, installmentCents: 100_000 } as const;
/** The retired fixed-fee offer (spec 135/140), still referenced by its quotes and engagements. */
const V1 = pricingPolicy("first_client_90d_v1")!;
const V1_MONEY = { totalCents: 750_000, termDays: 90, installments: 3, installmentCents: 250_000 } as const;

describe("current offer — canonical policy (1-7, 16)", () => {
  const p = activePricingPolicy();
  it("resolves to exactly one active policy with the expected economics in integer cents", () => {
    expect(PRICING_POLICIES.filter((x) => x.status === "active")).toHaveLength(1);
    expect(p.version).toBe("performance_fee_v1");
    expect(policyMoney(p)).toEqual(EXPECTED);
    expect(policyMoney(V1)).toEqual(V1_MONEY);
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
  it("pricing reply states the fixed fee first, the conditional fee second — never monthly billing", () => {
    const lines = pricingReplyLines(p);
    expect(lines[0]).toBe("It's $1,000 to start, and $4,000 only if we hit a measurable target we agree on before we begin.");
    expect(lines[2]).toBe("If the target isn't reached, the $4,000 isn't owed.");
    expect(lines.join(" ")).not.toMatch(/month/i);
    // The retired fixed-fee reply (v1) is unchanged.
    expect(pricingReplyLines(V1)[0]).toBe("The 90-day engagement is $7,500.");
  });
});

describe("installment schedule (17, 23, 26, 39)", () => {
  it("the current offer is one $1,000 installment at signing — the performance fee is never scheduled", () => {
    const s = installmentSchedule(activePricingPolicy().billing, "2026-10-01");
    expect(s.map((i) => [i.n, i.amountCents, i.dueOn])).toEqual([[1, 100_000, "2026-10-01"]]);
    expect(s.reduce((t, i) => t + i.amountCents, 0)).toBe(EXPECTED.totalCents);
  });
  it("retired v1: 3 × $2,500 at day 0 / 30 / 60 from the start date, exact total", () => {
    const s = installmentSchedule(V1.billing, "2026-10-01");
    expect(s.map((i) => [i.n, i.amountCents, i.dueOn])).toEqual([
      [1, 250_000, "2026-10-01"],
      [2, 250_000, "2026-10-31"],
      [3, 250_000, "2026-11-30"],
    ]);
    expect(s.reduce((t, i) => t + i.amountCents, 0)).toBe(V1_MONEY.totalCents);
  });
  it("invoice ids are deterministic per engagement and installment", () => {
    expect(installmentInvoiceId("0f9c1a2b-0000-4000-8000-000000000000", 2)).toBe("ENG-0F9C1A2B-2");
    expect(performanceInvoiceId("0f9c1a2b-0000-4000-8000-000000000000")).toBe("ENG-0F9C1A2B-P");
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
    expect(billingSnapshot(activePricingPolicy())).toEqual({ installments: 1, installmentUsd: 1_000, schedule: ["at signing"], dueDayOffsets: [0], performanceFee: { usd: 4_000, dueDaysAfterOutcome: 14, condition: "agreed_target_met" } });
    expect(billingSnapshot(V1)).toEqual({ installments: 3, installmentUsd: 2_500, schedule: ["at signing", "day 30", "day 60"], dueDayOffsets: [0, 30, 60] });
    expect(billingSnapshot(v0).installmentUsd).toBe(7_500);
  });
});

describe("payment semantics (24, 25, 28, 47, 48)", () => {
  const base = { contractTotalCents: V1_MONEY.totalCents, activationPaymentCents: V1_MONEY.installmentCents, invoicedCents: V1_MONEY.totalCents, overdueCount: 0 };
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
  it("spec 152: $1,000 paid while the target is pending is PAID_IN_FULL — no phantom $4,000 balance", () => {
    const perf = { contractTotalCents: contractTotalCents({ fixedCents: 100_000, performanceFeeCents: 400_000, outcome: "pending" }), activationPaymentCents: 100_000, invoicedCents: 100_000, receivedCents: 100_000, overdueCount: 0 };
    const pending = paymentState({ ...perf, performance: { outcome: "pending", feeCents: 400_000, paidCents: 0 } });
    expect(pending.status).toBe("PAID_IN_FULL");
    expect(pending.balanceCents).toBe(0);
    expect(pending.performance?.label).toBe("Performance fee: pending target");
    const notMet = paymentState({ ...perf, contractTotalCents: contractTotalCents({ fixedCents: 100_000, performanceFeeCents: 400_000, outcome: "not_met" }), performance: { outcome: "not_met", feeCents: 400_000, paidCents: 0 } });
    expect(notMet.status).toBe("PAID_IN_FULL");
    expect(notMet.performance?.label).toBe("Performance fee: not owed");
    const met = paymentState({ ...perf, contractTotalCents: contractTotalCents({ fixedCents: 100_000, performanceFeeCents: 400_000, outcome: "met" }), invoicedCents: 500_000, performance: { outcome: "met", feeCents: 400_000, paidCents: 0 } });
    expect(met.status).toBe("PARTIALLY_PAID");
    expect(met.balanceCents).toBe(400_000);
    expect(met.performance?.label).toBe("Performance fee: due $4,000");
    const paid = paymentState({ ...perf, contractTotalCents: 500_000, invoicedCents: 500_000, receivedCents: 500_000, performance: { outcome: "met", feeCents: 400_000, paidCents: 400_000 } });
    expect(paid.status).toBe("PAID_IN_FULL");
    expect(paid.performance?.label).toBe("Performance fee: paid $4,000");
    expect(paymentState({ ...perf, performance: null }).performance).toBeNull();
  });
  it("run rate is labelled ANNUALIZED RUN RATE and never presented as contracted annual revenue", () => {
    const r = runRate(V1);
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
    performanceFeeUsd: null, performanceTarget: null, performanceOutcome: "not_applicable", performanceOutcomeSnapshotId: null, performanceOutcomeBy: null, performanceOutcomeAt: null, performanceOutcomeNote: null,
    ...over,
  };
}

describe("agreement artifact (14-22)", () => {
  const snapshot = buildAgreementSnapshot({
    engagement: engagementFixture(),
    quote: { id: "22222222-2222-4222-8222-222222222222", presentedAt: new Date("2026-09-30T12:00:00Z"), billing: billingSnapshot(V1), scopeVersion: "scope_90d_market_implementation_v1" },
    provider: { legalName: "Recommended First", postalAddress: "Brooklyn, NY" },
    brandName: "Acme Realty Test Team",
    now: new Date("2026-10-01T00:00:00Z"),
  });
  const md = renderAgreement(snapshot);
  it("binds to the quote and the template version, and records NOT_REVIEWED", () => {
    expect(snapshot.commercial.quoteId).toBe("22222222-2222-4222-8222-222222222222");
    expect(snapshot.templateVersion).toBe(AGREEMENT_TEMPLATE_V1);
    expect(snapshot.performance).toBeUndefined();
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
    for (const inc of V1.includes) expect(md).toContain(inc);
    for (const g of AGREEMENT_CLAUSES.noGuarantee) expect(md).toContain(g);
    expect(md).toContain("probabilistic");
    expect(md).toContain("**Client:** Acme Realty Test Team LLC (Acme Realty Test Team)");
    expect(md).toContain("**Provider:** Recommended First, Brooklyn, NY");
    expect(md).not.toMatch(/\$7,500\/month|\$22,500/);
  });
  it("is deterministic: same snapshot → same hash", () => {
    expect(agreementHash(renderAgreement(snapshot))).toBe(agreementHash(md));
  });
  it("spec 152: a v1 agreement re-renders byte-identically to what the spec 140 renderer produced", () => {
    // Pinned from the pre-spec-152 renderer over this exact snapshot.
    expect(agreementHash(renderAgreement({ ...snapshot, createdAt: "2026-10-01T00:00:00.000Z" }))).toBe(V1_GOLDEN_HASH);
  });
  it("a pre-quote engagement renders from its own snapshot (one upfront installment when no policy matches)", () => {
    const s2 = buildAgreementSnapshot({ engagement: engagementFixture({ quoteId: null, pricingPolicyVersion: null, totalValueUsd: 9_000, monthlyFeeUsd: 9_000 }), quote: null, provider: { legalName: "Recommended First", postalAddress: "" }, brandName: "X", now: new Date() });
    expect(s2.commercial.installments).toHaveLength(1);
    expect(s2.commercial.installments[0]!.amountUsd).toBe(9_000);
  });
});

describe("agreement artifact v2 — performance fee (spec 152)", () => {
  const p = activePricingPolicy();
  const target: PerformanceTarget = {
    primary: { metric: "recommendation_rate", thresholdPercent: 25, baselinePercent: 6.3 },
    secondary: { metric: "question_coverage", thresholdPercent: 40, baselinePercent: 12.5 },
    instrument: { promptSetVersionId: "33333333-3333-4333-8333-333333333333", questionCount: 16, provider: "openai", models: ["gpt-5.4-2026-03-05"], repetitions: 4, scoringVersion: "v1.1" },
    entityNames: ["Acme Realty Test Team", "Acme Realty"],
    baselineMeasurementId: "44444444-4444-4444-8444-444444444444",
    baselineFrozenOn: "2026-10-02",
    rerunOn: "2026-12-31",
    agreedOn: "2026-10-03",
    note: null,
  };
  const engagement = engagementFixture({ monthlyFeeUsd: 1_000, totalValueUsd: 1_000, billingCadence: "upfront", pricingPolicyVersion: p.version, defaultTotalValueUsd: 1_000, performanceFeeUsd: 4_000, performanceOutcome: "pending", performanceTarget: target });
  const quote = { id: "22222222-2222-4222-8222-222222222222", presentedAt: new Date("2026-09-30T12:00:00Z"), billing: billingSnapshot(p), scopeVersion: "scope_90d_performance_v1" };
  const snap = buildAgreementSnapshot({ engagement, quote, provider: { legalName: "Recommended First", postalAddress: "Brooklyn, NY" }, brandName: "Acme Realty Test Team", now: new Date("2026-10-03T00:00:00Z") });
  const md = renderAgreement(snap);
  it("renders engagement_agreement_v2 with the fixed fee, what it covers, and the performance clause from the frozen target", () => {
    expect(snap.templateVersion).toBe(AGREEMENT_TEMPLATE_V2);
    expect(snap.templateVersion).toBe(AGREEMENT_TEMPLATE_VERSION);
    expect(md).toContain("Legal review: NOT_REVIEWED");
    expect(md).toContain("Fixed fee: **$1,000** for the 90-day engagement:");
    expect(md).toContain("- $1,000 — at signing (due 2026-10-01)");
    for (const inc of p.includes) expect(md).toContain(inc);
    expect(md).toContain("Performance fee: **$4,000**, owed only if the agreed target below is reached at the rerun.");
    expect(md).toContain("due 14 days after that record");
    expect(md).toContain(AGREEMENT_V2_CLAUSES.performanceNotOwed);
    expect(md).toContain("Recommendation rate of at least 25%");
    expect(md).toContain("Question coverage of at least 40%");
    expect(md).toContain("The target is reached when both thresholds are reached at the rerun:");
    expect(md).toContain("version 33333333-3333-4333-8333-333333333333, 16 questions");
    expect(md).toContain("openai, model gpt-5.4-2026-03-05");
    expect(md).toContain("Repetitions: 4 per question");
    expect(md).toContain("Scoring version: v1.1");
    expect(md).toContain("Acme Realty Test Team, Acme Realty");
    expect(md).toContain("The baseline was frozen on 2026-10-02; the agreed target is measured by the rerun on or after 2026-12-31.");
    for (const m of AGREEMENT_V2_CLAUSES.measurementMethod) expect(md).toContain(m);
    expect(md).toContain("The exact model version is reported for both the baseline and the rerun.");
    for (const g of AGREEMENT_CLAUSES.noGuarantee) expect(md).toContain(g);
    expect(md).toContain(AGREEMENT_CLAUSES.exclusivity);
  });
  it("never uses the word pilot or a forbidden framing, and promises no ranking, leads or transactions", () => {
    expect(md).not.toMatch(/pilot|discount|founding|introductory|special|guaranteed\b/i);
    expect(md).not.toMatch(/\bwe guarantee|will rank|more leads/i);
  });
  it("refuses to render a performance engagement without its frozen target", () => {
    expect(() => buildAgreementSnapshot({ engagement: { ...engagement, performanceTarget: null }, quote, provider: { legalName: "R", postalAddress: "" }, brandName: "A", now: new Date() })).toThrow(/performance target/);
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
    expect(now.pricingPolicyVersion).toBe("performance_fee_v1");
    expect(now.price).toBe("$1,000 to start, plus $4,000 only if the agreed target is reached");
    expect(now.includesLabel).toBe("The $1,000 covers");
    expect(JSON.stringify(now)).not.toMatch(/pilot|discount|founding|introductory|special|guarantee/i);
    expect(JSON.stringify(now)).not.toContain("$7,500");
    expect(JSON.stringify(now)).not.toContain("$22,500");
    const v0 = offerSection(pricingPolicy("founder_monthly_7500_v0")!);
    expect(JSON.stringify(v0)).toContain("$22,500");
  });
});
