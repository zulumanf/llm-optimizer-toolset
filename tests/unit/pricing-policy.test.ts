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
  offerLabel,
  paymentTermsDefault,
  policyStatedIn,
  pricingPolicy,
  pricingReplyLines,
  resolveEngagementPricing,
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

describe("active policy", () => {
  it("1: is $7,500 / 90 days, one entity, one market, exclusivity for the term", () => {
    const p = activePricingPolicy();
    expect(p.version).toBe("first_client_90d_v1");
    expect(p.totalFeeUsd).toBe(7_500);
    expect(p.termDays).toBe(90);
    expect(offerLabel(p)).toBe("$7,500 / 90 days");
    expect(p.scope).toMatchObject({ entities: 1, markets: 1 });
    expect(p.scope.exclusivity).toMatch(/during the paid engagement/);
    expect(PRICING_POLICIES.filter((x) => x.status === "active")).toHaveLength(1);
  });

  it("3: bills $2,500 × 3 at signing, day 30, day 60 as one engagement", () => {
    const p = activePricingPolicy();
    expect(billingLabel(p)).toBe("$2,500 × 3");
    expect(p.billing.installments * p.billing.installmentUsd).toBe(p.totalFeeUsd);
    expect([...p.billing.schedule]).toEqual(["at signing", "day 30", "day 60"]);
    expect(paymentTermsDefault(p)).toBe("$7,500 total for the 90-day engagement, invoiced $2,500 × 3: at signing, day 30, day 60.");
  });

  it("leads with the total, never a subscription, never a discount", () => {
    const p = activePricingPolicy();
    const text = [p.customerFacing.price, p.customerFacing.billing, p.customerFacing.commitment, ...p.includes, ...pricingReplyLines(p)].join(" ");
    expect(p.customerFacing.price).toBe("$7,500 for the 90-day engagement");
    expect(text).not.toMatch(/discount|founding|pilot|beta|introductory|special offer|subscription|rank(ing)?s? guarantee|leads?\b|transactions?/i);
    expect(pricingReplyLines(p)).toEqual([
      "The 90-day engagement is $7,500.",
      "That includes the baseline, implementation of the highest-confidence changes, monitoring, and the comparable rerun at the end.",
      "We bill it as $2,500 per month over the 90 days.",
    ]);
  });
});

describe("historical policy (Ryan)", () => {
  it("4-5: the retired v0 policy reproduces Ryan's delivered offer exactly and is not quotable", () => {
    const v0 = pricingPolicy("founder_monthly_7500_v0")!;
    expect(v0.status).toBe("retired");
    expect(v0.totalFeeUsd).toBe(22_500);
    const o = offerSection(v0);
    expect({ price: o.price, total: o.total, includes: o.includes, commitment: o.commitment }).toEqual(RYAN_OFFER);
    expect(() => assertQuotablePolicy("founder_monthly_7500_v0")).toThrow(/not active/);
    expect(() => assertQuotablePolicy("nope_v9")).toThrow(/Unknown/);
    expect(assertQuotablePolicy("first_client_90d_v1").version).toBe("first_client_90d_v1");
  });

  it("13: the active section differs from the historical one — old snapshots do not drift because they hold their own text", () => {
    const now = offerSection();
    expect(now.price).not.toBe(RYAN_OFFER.price);
    expect(now.pricingPolicyVersion).toBe("first_client_90d_v1");
    expect(offerSection(pricingPolicy("founder_monthly_7500_v0")!).pricingPolicyVersion).toBe("founder_monthly_7500_v0");
  });
});

describe("engagement pricing resolution", () => {
  it("2: policy terms need no reason and record the default", () => {
    expect(resolveEngagementPricing({ totalValueUsd: 7_500, termDays: 90 })).toEqual({
      policyVersion: "first_client_90d_v1", defaultTotalValueUsd: 7_500, totalValueUsd: 7_500, overrideReason: null,
    });
  });
  it("10-11: a different total or term requires a reason and keeps the default next to the actual", () => {
    expect(() => resolveEngagementPricing({ totalValueUsd: 5_000, termDays: 90 })).toThrow(/override reason is required/);
    expect(() => resolveEngagementPricing({ totalValueUsd: 7_500, termDays: 120 })).toThrow(/override reason/);
    expect(resolveEngagementPricing({ totalValueUsd: 15_000, termDays: 90, priceOverrideReason: "two markets in scope" })).toEqual({
      policyVersion: "first_client_90d_v1", defaultTotalValueUsd: 7_500, totalValueUsd: 15_000, overrideReason: "two markets in scope",
    });
  });
});

describe("quote detection and taxonomy", () => {
  it("8: a body stating an offer resolves to its policy version; other bodies do not", () => {
    expect(policyStatedIn("The 90-day engagement is $7,500. We bill it as $2,500 per month.")?.version).toBe("first_client_90d_v1");
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
