/**
 * Spec 135: the pricing policy list is the single source of every price the
 * OS states. Active offer, billing, override discipline, retired policies,
 * quote detection, the founder-ready reply, and the historical Ryan offer
 * text — all pinned here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  activePricingPolicy,
  assertQuotablePolicy,
  billingLabel,
  maximumFeeUsd,
  offerLabel,
  paymentTermsDefault,
  policyStatedIn,
  pricingPolicy,
  pricingReplyLines,
  pricingReplyTemplateVersion,
  resolveEngagementPricing,
  runRate,
  validatePolicy,
  PRICING_REPLY_TEMPLATE_VERSION,
  PRICING_OBJECTIONS,
  PRICING_POLICIES,
} from "@/lib/pricing/policy";
import { offerSection } from "@/lib/prospects/audit-mismatch";

const ROOT = join(__dirname, "..", "..");

/** Ryan Ogle's delivered offer section, verbatim from the frozen snapshot
 * (prospect_audits 2772b835, published 2026-09-05). Historical truth. */
const RYAN_OFFER = {
  price: "$7,500/month for 3 months",
  total: "$22,500 total initial engagement",
  includes: ["diagnosis", "implementation of the highest-confidence changes", "ongoing monitoring", "rerunning the same test"],
  commitment: "No long-term commitment after the initial 90 days.",
};

/** Customer-facing words the platform never uses (docs/15, founder decision 2026-10-28). */
const FORBIDDEN_CUSTOMER_WORDS = /discount|founding|pilot|beta|introductory|special|guarantee|subscription|leads?\b|transactions?|rankings?/i;

describe("active policy (spec 152)", () => {
  it("is $1,000 fixed + $4,000 on an agreed target over 90 days, one entity, one market, exclusivity for the term", () => {
    const p = activePricingPolicy();
    expect(p.version).toBe("performance_fee_v1");
    expect(p.totalFeeUsd).toBe(1_000);
    expect(p.performanceFee).toEqual({ usd: 4_000, dueDaysAfterOutcome: 14, condition: "agreed_target_met" });
    expect(maximumFeeUsd(p)).toBe(5_000);
    expect(p.termDays).toBe(90);
    expect(offerLabel(p)).toBe("$1,000 + $4,000 on target / 90 days");
    expect(p.scope).toMatchObject({ entities: 1, markets: 1 });
    expect(p.scope.exclusivity).toMatch(/during the engagement/);
    expect(PRICING_POLICIES.filter((x) => x.status === "active")).toHaveLength(1);
  });

  it("bills the $1,000 once at signing; the performance fee is never an installment", () => {
    const p = activePricingPolicy();
    expect(p.billing).toEqual({ installments: 1, installmentUsd: 1_000, schedule: ["at signing"], dueDayOffsets: [0], cadence: "upfront" });
    expect(p.billing.installments * p.billing.installmentUsd).toBe(p.totalFeeUsd);
    expect(billingLabel(p)).toBe("$1,000 at signing + $4,000 if target met");
    expect(paymentTermsDefault(p)).toBe("$1,000 fixed fee for the 90-day engagement, invoiced at signing. Performance fee $4,000, invoiced only when the agreed target is recorded as met and due 14 days after; not owed if the target is not met.");
  });

  it("the fixed fee covers, in writing, the baseline, the diagnosis and plan, and the first changes", () => {
    const p = activePricingPolicy();
    expect(p.includes).toHaveLength(3);
    expect(p.includes[0]).toMatch(/frozen baseline/);
    expect(p.includes[1]).toMatch(/diagnosis and a priority work plan/);
    expect(p.includes[2]).toMatch(/highest-confidence first changes/);
  });

  it("pricing_reply_v2: two-part fee, the frozen rerun, never monthly billing, never a forbidden word", () => {
    const p = activePricingPolicy();
    expect(PRICING_REPLY_TEMPLATE_VERSION).toBe("pricing_reply_v2");
    expect(pricingReplyTemplateVersion(p)).toBe("pricing_reply_v2");
    expect(pricingReplyLines(p)).toEqual([
      "It's $1,000 to start, and $4,000 only if we hit a measurable target we agree on before we begin.",
      "The target is measured by rerunning the same frozen set of ChatGPT questions after 90 days.",
      "If the target isn't reached, the $4,000 isn't owed.",
    ]);
    const text = [p.offerName, p.customerFacing.price, p.customerFacing.billing, p.customerFacing.commitment, ...p.includes, ...pricingReplyLines(p)].join(" ");
    expect(text).not.toMatch(/per month|monthly|\/month/i);
    expect(text).not.toMatch(FORBIDDEN_CUSTOMER_WORDS);
    expect(p.customerFacing.commitment).toContain("Most of the fee depends on a result we agree in advance");
  });

  it("run rate counts contracted money only; the performance fee is contingent and not contracted", () => {
    const r = runRate(activePricingPolicy());
    expect(r.contractedTotalUsd).toBe(1_000);
    expect(r.monthlyEquivalentUsd).toBe(333.33);
    expect(r.annualizedRunRateUsd).toBe(3_999.96);
    expect(r.contingentUsd).toBe(4_000);
    expect(r.contingentLabel).toBe("CONTINGENT — NOT CONTRACTED");
  });

  it("refuses a policy whose performance fee is not positive", () => {
    const p = activePricingPolicy();
    expect(() => validatePolicy({ ...p, performanceFee: { ...p.performanceFee!, usd: 0 } })).toThrow(/greater than zero/);
  });
});

describe("retired policies", () => {
  it("first_client_90d_v1 is retired on 2026-10-17, still resolves by version, and its v1 reply is unchanged", () => {
    const v1 = pricingPolicy("first_client_90d_v1")!;
    expect(v1).toMatchObject({ status: "retired", effectiveTo: "2026-10-17", totalFeeUsd: 7_500 });
    expect(() => assertQuotablePolicy("first_client_90d_v1", new Date("2026-10-18T12:00:00Z"))).toThrow(/not active/);
    expect(() => assertQuotablePolicy("first_client_90d_v1")).toThrow(/not active/);
    expect(pricingReplyTemplateVersion(v1)).toBe("pricing_reply_v1");
    expect(pricingReplyLines(v1)).toEqual([
      "The 90-day engagement is $7,500.",
      "That includes the baseline, implementation of the highest-confidence changes, monitoring, and the comparable rerun at the end.",
      "We bill it as $2,500 per month over the 90 days.",
    ]);
    expect(offerLabel(v1)).toBe("$7,500 / 90 days");
    expect(billingLabel(v1)).toBe("$2,500 × 3");
  });
});

describe("historical policy (Ryan)", () => {
  it("4-5: the retired v0 policy reproduces Ryan's delivered offer exactly and is not quotable", () => {
    const v0 = pricingPolicy("founder_monthly_7500_v0")!;
    expect(v0.status).toBe("retired");
    expect(v0.totalFeeUsd).toBe(22_500);
    const o = offerSection(v0);
    expect({ price: o.price, total: o.total, includes: o.includes, commitment: o.commitment }).toEqual(RYAN_OFFER);
    expect(o.includesLabel).toBeUndefined();
    expect(() => assertQuotablePolicy("founder_monthly_7500_v0")).toThrow(/not active/);
    expect(() => assertQuotablePolicy("nope_v9")).toThrow(/Unknown/);
    expect(assertQuotablePolicy("performance_fee_v1").version).toBe("performance_fee_v1");
  });

  it("13: the active section differs from the historical one — old snapshots do not drift because they hold their own text", () => {
    const now = offerSection();
    expect(now.price).not.toBe(RYAN_OFFER.price);
    expect(now.pricingPolicyVersion).toBe("performance_fee_v1");
    expect(offerSection(pricingPolicy("founder_monthly_7500_v0")!).pricingPolicyVersion).toBe("founder_monthly_7500_v0");
  });
});

describe("engagement pricing resolution", () => {
  it("2: policy terms need no reason and record the defaults (fixed and performance)", () => {
    expect(resolveEngagementPricing({ totalValueUsd: 1_000, termDays: 90 })).toEqual({
      policyVersion: "performance_fee_v1", defaultTotalValueUsd: 1_000, totalValueUsd: 1_000, defaultPerformanceFeeUsd: 4_000, performanceFeeUsd: 4_000, overrideReason: null,
    });
    expect(resolveEngagementPricing({ totalValueUsd: 1_000, termDays: 90, performanceFeeUsd: 4_000 }).overrideReason).toBeNull();
  });
  it("10-11: a different fixed fee, performance fee or term requires a reason and keeps the default next to the actual", () => {
    expect(() => resolveEngagementPricing({ totalValueUsd: 500, termDays: 90 })).toThrow(/override reason is required/);
    expect(() => resolveEngagementPricing({ totalValueUsd: 1_000, termDays: 120 })).toThrow(/override reason/);
    expect(() => resolveEngagementPricing({ totalValueUsd: 1_000, termDays: 90, performanceFeeUsd: 3_000 })).toThrow(/override reason/);
    expect(() => resolveEngagementPricing({ totalValueUsd: 1_000, termDays: 90, performanceFeeUsd: null })).toThrow(/override reason/);
    expect(resolveEngagementPricing({ totalValueUsd: 2_000, termDays: 90, performanceFeeUsd: 8_000, priceOverrideReason: "two markets in scope" })).toEqual({
      policyVersion: "performance_fee_v1", defaultTotalValueUsd: 1_000, totalValueUsd: 2_000, defaultPerformanceFeeUsd: 4_000, performanceFeeUsd: 8_000, overrideReason: "two markets in scope",
    });
    expect(resolveEngagementPricing({ totalValueUsd: 7_500, termDays: 90, performanceFeeUsd: 0, priceOverrideReason: "fixed-fee engagement" }).performanceFeeUsd).toBeNull();
  });
});

describe("quote detection and taxonomy", () => {
  it("8: a body stating an offer resolves to its policy version; other bodies do not", () => {
    expect(policyStatedIn("The 90-day engagement is $7,500. We bill it as $2,500 per month.")?.version).toBe("first_client_90d_v1");
    expect(policyStatedIn(pricingReplyLines().join("\n"))?.version).toBe("performance_fee_v1");
    expect(policyStatedIn("Here it is: $7,500/month for 3 months, $22,500 total.")?.version).toBe("founder_monthly_7500_v0");
    expect(policyStatedIn("Here it is: https://app.recommendedfirst.com/report/x/y")).toBeNull();
  });
  it("objection taxonomy holds Ryan's two categories", () => {
    expect(PRICING_OBJECTIONS).toContain("PRICE_TOO_HIGH");
    expect(PRICING_OBJECTIONS).toContain("PREFERS_DIY");
  });
});

describe("7: cold outreach carries no pricing", () => {
  it("T1, T2/T3 and EVIDENCE_CORRECTION template sources state no price", () => {
    for (const rel of ["lib/prospects/mismatch.ts", "lib/prospects/followups.ts", "lib/prospects/correction-templates.ts"]) {
      const src = readFileSync(join(ROOT, rel), "utf8");
      expect(src, rel).not.toMatch(/\$\s?\d[\d,]*\s?(\/|per)\s?(mo|month)/i);
      expect(src, rel).not.toMatch(/\$(7,?500|2,?500|22,?500|10,?000|5,?000|4,?000|3,?500)\b/);
      expect(src, rel).not.toMatch(/90-day engagement is/);
    }
  });
});
