/**
 * Pricing policy (spec 135). Every price Recommended First has ever stated is
 * a versioned policy in this list — pinned in code, versioned in git, like the
 * model registry. Quotes and engagements reference a policy by version, so a
 * later price change never rewrites what an earlier prospect was told.
 *
 * Exactly one policy is ACTIVE. It is "the current offer": never a discount,
 * pilot, beta, founding or introductory price in customer-facing copy.
 * Future scope-based policies (local / major / multi-market) are new entries
 * here, activated by a founder decision — never inferred from a prospect's
 * wealth, production volume or market size.
 */
import { ClassifiedError } from "@/lib/errors";

export type PricingPolicyStatus = "active" | "retired";

export interface BillingStructure {
  /** Number of invoices over the term. */
  installments: number;
  installmentUsd: number;
  /** Customer-facing due points, one per installment. */
  schedule: readonly string[];
  /** Maps onto client_engagements.billing_cadence. */
  cadence: "monthly" | "upfront" | "custom";
}

export interface PricingPolicy {
  version: string;
  offerName: string;
  termDays: number;
  totalFeeUsd: number;
  billing: BillingStructure;
  effectiveFrom: string;
  effectiveTo: string | null;
  status: PricingPolicyStatus;
  /** Internal framing only — never rendered to a prospect. */
  internalLabel: string;
  /** What the fee buys, customer-facing, short. */
  includes: readonly string[];
  /** Scope boundary: one entity, one market, one engagement. */
  scope: { entities: number; markets: number; exclusivity: string };
  /** Customer-facing sentences. */
  customerFacing: { price: string; billing: string; commitment: string };
  /** Substrings that identify this offer inside a sent body (quote detection). */
  offerMarkers: readonly string[];
}

export const PRICING_POLICIES: readonly PricingPolicy[] = [
  {
    version: "founder_monthly_7500_v0",
    offerName: "Initial 90-day engagement",
    termDays: 90,
    totalFeeUsd: 22_500,
    billing: { installments: 3, installmentUsd: 7_500, schedule: ["month 1", "month 2", "month 3"], cadence: "monthly" },
    effectiveFrom: "2026-09-05",
    effectiveTo: "2026-09-07",
    status: "retired",
    internalLabel: "founder decision 2026-09-05; quoted once (Ryan Ogle); declined on price",
    includes: ["diagnosis", "implementation of the highest-confidence changes", "ongoing monitoring", "rerunning the same test"],
    scope: { entities: 1, markets: 1, exclusivity: "one retained client in the defined market during the engagement" },
    customerFacing: {
      price: "$7,500/month for 3 months",
      billing: "$22,500 total initial engagement",
      commitment: "No long-term commitment after the initial 90 days.",
    },
    offerMarkers: ["$7,500/month", "$22,500"],
  },
  {
    version: "first_client_90d_v1",
    offerName: "90-Day Market Implementation Engagement",
    termDays: 90,
    totalFeeUsd: 7_500,
    billing: { installments: 3, installmentUsd: 2_500, schedule: ["at signing", "day 30", "day 60"], cadence: "monthly" },
    effectiveFrom: "2026-09-07",
    effectiveTo: null,
    status: "active",
    internalLabel: "early-stage validation pricing — first three paying clients; proof, delivery learning, case studies, willingness-to-pay",
    includes: [
      "the baseline: a verified AI recommendation benchmark against your competitors, with every answer saved",
      "diagnosis and a priority work plan from that evidence",
      "implementation of the highest-confidence changes on your site and profiles",
      "monitoring of the changes and the competitive set",
      "the comparable rerun at the end, before and after, limitations stated",
      "one retained client in your defined market during the engagement",
    ],
    scope: { entities: 1, markets: 1, exclusivity: "one retained client within the founder-confirmed defined market during the paid engagement" },
    customerFacing: {
      price: "$7,500 for the 90-day engagement",
      billing: "Billed as $2,500 per month over the 90 days",
      commitment: "One 90-day engagement. Nothing continues after it unless we both choose to.",
    },
    offerMarkers: ["$7,500 for the 90-day", "90-day engagement is $7,500"],
  },
] as const;

/** Simple deterministic objection categories (several may apply). */
export const PRICING_OBJECTIONS = [
  "PRICE_TOO_HIGH",
  "PREFERS_DIY",
  "PROOF_INSUFFICIENT",
  "NOT_PRIORITY",
  "TIMING",
  "BUDGET_UNAVAILABLE",
  "SCOPE_UNCLEAR",
  "NO_INTEREST",
  "UNKNOWN",
] as const;
export type PricingObjection = (typeof PRICING_OBJECTIONS)[number];

export const PREFERRED_SOLUTIONS = ["DONE_FOR_YOU", "DONE_WITH_YOU", "DIY"] as const;
export type PreferredSolution = (typeof PREFERRED_SOLUTIONS)[number];

export const QUOTE_STATUSES = ["presented", "accepted", "declined", "withdrawn"] as const;
export const QUOTE_OUTCOMES = ["open", "client_won", "lost"] as const;

/** Founder-visible decision points. Nothing raises price automatically. */
export const PRICING_MILESTONES = {
  earlyReviewConversations: 3,
  firstProofClients: 3,
  validatedCompletedEngagements: 1,
} as const;

export function activePricingPolicy(): PricingPolicy {
  const active = PRICING_POLICIES.filter((p) => p.status === "active");
  if (active.length !== 1) throw new Error(`exactly one active pricing policy expected, found ${active.length}`);
  return active[0]!;
}

export function pricingPolicy(version: string): PricingPolicy | null {
  return PRICING_POLICIES.find((p) => p.version === version) ?? null;
}

/** The policy a NEW quote or engagement may use. A retired or expired policy
 * is refused — old prices are history, not a menu. */
export function assertQuotablePolicy(version: string, at: Date = new Date()): PricingPolicy {
  const p = pricingPolicy(version);
  if (!p) throw new ClassifiedError("validation", `Unknown pricing policy "${version}".`);
  const day = at.toISOString().slice(0, 10);
  if (p.status !== "active" || day < p.effectiveFrom || (p.effectiveTo !== null && day > p.effectiveTo)) {
    throw new ClassifiedError("validation", `Pricing policy "${version}" is not active; new quotes use ${activePricingPolicy().version}.`);
  }
  return p;
}

export const usd = (n: number): string => `$${n.toLocaleString("en-US")}`;

/** "$7,500 / 90 days" */
export function offerLabel(p: PricingPolicy = activePricingPolicy()): string {
  return `${usd(p.totalFeeUsd)} / ${p.termDays} days`;
}

/** "$2,500 × 3" */
export function billingLabel(p: PricingPolicy = activePricingPolicy()): string {
  return `${usd(p.billing.installmentUsd)} × ${p.billing.installments}`;
}

/** Default engagement payment terms sentence for the sign dialog. */
export function paymentTermsDefault(p: PricingPolicy = activePricingPolicy()): string {
  return `${usd(p.totalFeeUsd)} total for the ${p.termDays}-day engagement, invoiced ${billingLabel(p)}: ${p.billing.schedule.join(", ")}.`;
}

/** Which policy a sent body states, if any (markers are policy-specific). */
export function policyStatedIn(body: string): PricingPolicy | null {
  for (const p of PRICING_POLICIES) {
    if (p.offerMarkers.some((m) => body.includes(m))) return p;
  }
  return null;
}

/** The founder-ready answer to "what does it cost?" (docs/13-prompts.md,
 * pricing_reply_v1). Three sentences, no essay, no anchoring, no urgency. */
export const PRICING_REPLY_TEMPLATE_VERSION = "pricing_reply_v1";
export function pricingReplyLines(p: PricingPolicy = activePricingPolicy()): string[] {
  return [
    `The ${p.termDays}-day engagement is ${usd(p.totalFeeUsd)}.`,
    "That includes the baseline, implementation of the highest-confidence changes, monitoring, and the comparable rerun at the end.",
    `We bill it as ${usd(p.billing.installmentUsd)} per month over the ${p.termDays} days.`,
  ];
}

export interface EngagementPricingInput {
  totalValueUsd: number;
  termDays: number;
  priceOverrideReason?: string | null;
}

export interface ResolvedEngagementPricing {
  policyVersion: string;
  defaultTotalValueUsd: number;
  totalValueUsd: number;
  overrideReason: string | null;
}

/**
 * Engagement terms against the active policy: matching terms need no reason;
 * any other total or term is a founder override and must say why. The
 * default is always recorded next to the actual, so an override can be read
 * later as exactly what it was.
 */
export function resolveEngagementPricing(input: EngagementPricingInput, p: PricingPolicy = activePricingPolicy()): ResolvedEngagementPricing {
  const reason = input.priceOverrideReason?.trim() || null;
  const differs = input.totalValueUsd !== p.totalFeeUsd || input.termDays !== p.termDays;
  if (differs && !reason) {
    throw new ClassifiedError(
      "validation",
      `Terms differ from the active offer (${offerLabel(p)}); a founder override reason is required. No silent discounting.`
    );
  }
  return { policyVersion: p.version, defaultTotalValueUsd: p.totalFeeUsd, totalValueUsd: input.totalValueUsd, overrideReason: differs ? reason : null };
}
