/**
 * Pricing policy (spec 135). Every price Recommended First has ever stated is
 * a versioned policy in this list — pinned in code, versioned in git, like the
 * model registry. Quotes and engagements reference a policy by version, so a
 * later price change never rewrites what an earlier prospect was told.
 *
 * Exactly one policy is ACTIVE. It is "the current offer": never a discount,
 * pilot, beta, founding or introductory price in customer-facing copy.
 * Spec 152: a policy may carry a PERFORMANCE FEE — owed only when the founder
 * records an agreed, frozen target as met. `totalFeeUsd` is always the fixed,
 * contracted fee; the performance fee is never an installment, never run
 * rate and never pipeline value until it is recorded as met.
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
  /** Days after the start date each installment falls due, one per installment. */
  dueDayOffsets: readonly number[];
  /** Maps onto client_engagements.billing_cadence. */
  cadence: "monthly" | "upfront" | "custom";
}

/** Spec 152: the only condition a performance fee may carry. */
export const PERFORMANCE_FEE_CONDITION = "agreed_target_met" as const;
export type PerformanceFeeCondition = typeof PERFORMANCE_FEE_CONDITION;

/** Spec 152: a fee owed only after the founder records the agreed target as met. */
export interface PerformanceFee {
  usd: number;
  /** Days after the outcome is recorded as met that the performance invoice falls due. */
  dueDaysAfterOutcome: number;
  condition: PerformanceFeeCondition;
}

export interface PricingPolicy {
  version: string;
  offerName: string;
  termDays: number;
  /** The FIXED, contracted fee. Never includes a performance fee. */
  totalFeeUsd: number;
  billing: BillingStructure;
  /** Spec 152: owed only on a recorded "met" outcome; never an installment. */
  performanceFee?: PerformanceFee;
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
    billing: { installments: 3, installmentUsd: 7_500, schedule: ["month 1", "month 2", "month 3"], dueDayOffsets: [0, 30, 60], cadence: "monthly" },
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
    billing: { installments: 3, installmentUsd: 2_500, schedule: ["at signing", "day 30", "day 60"], dueDayOffsets: [0, 30, 60], cadence: "monthly" },
    effectiveFrom: "2026-09-07",
    effectiveTo: "2026-10-17",
    status: "retired",
    internalLabel: "retired 2026-10-17 (spec 152). Was: early-stage validation pricing — first three paying clients; proof, delivery learning, case studies, willingness-to-pay",
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
  {
    version: "performance_fee_v1",
    offerName: "90-Day Performance-Based Engagement",
    termDays: 90,
    totalFeeUsd: 1_000,
    billing: { installments: 1, installmentUsd: 1_000, schedule: ["at signing"], dueDayOffsets: [0], cadence: "upfront" },
    performanceFee: { usd: 4_000, dueDaysAfterOutcome: 14, condition: PERFORMANCE_FEE_CONDITION },
    effectiveFrom: "2026-10-17",
    effectiveTo: null,
    status: "active",
    internalLabel: "founder decision 2026-10-17 (spec 152): performance fee — $1,000 fixed, $4,000 only on an agreed, frozen target recorded as met",
    // Founder decision 2026-10-28: what the fixed fee covers, in writing.
    includes: [
      "the frozen baseline: a verified AI recommendation benchmark against your competitors, with every answer saved",
      "diagnosis and a priority work plan from that evidence",
      "implementation of the highest-confidence first changes on your site and profiles",
    ],
    scope: { entities: 1, markets: 1, exclusivity: "one retained client within the founder-confirmed defined market during the engagement" },
    customerFacing: {
      price: "$1,000 to start, plus $4,000 only if the agreed target is reached",
      billing: "The $1,000 is due at signing. The target is measured by rerunning the same frozen set of ChatGPT questions 90 days after the baseline; if it isn't reached, the $4,000 isn't owed.",
      commitment: "Most of the fee depends on a result we agree in advance. While we work together, I take no other client in your defined market.",
    },
    offerMarkers: ["$1,000 to start", "$4,000 only if"],
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

/** Spec 140: draft = prepared, not yet shown; presented = frozen; superseded =
 * an unpresented draft regenerated under a newer policy. */
export const QUOTE_STATUSES = ["draft", "presented", "accepted", "declined", "withdrawn", "superseded"] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];
/** Statuses the founder may record as the prospect's response. */
export const QUOTE_RESPONSE_STATUSES = ["accepted", "declined", "withdrawn"] as const;
/** A quote still in play for a prospect (one at a time). */
export const OPEN_QUOTE_STATUSES: readonly QuoteStatus[] = ["draft", "presented", "accepted"];
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
  return validatePolicy(active[0]!);
}

// ------------------------------------------------------------------ money
// Money is whole USD in policy entries and integer cents everywhere it is
// summed (billing_events.amount_cents). No float arithmetic on amounts.

const CENTS_PER_USD = 100;

/** Whole-dollar or exact-cent USD → integer cents. Refuses sub-cent input. */
export function usdToCents(usd: number): number {
  const cents = Math.round(usd * CENTS_PER_USD);
  if (!Number.isFinite(usd) || Math.abs(cents - usd * CENTS_PER_USD) > 1e-6) {
    throw new ClassifiedError("validation", `Amount ${usd} is not an exact number of cents.`);
  }
  return cents;
}

export function centsToUsd(cents: number): number {
  return cents / CENTS_PER_USD;
}

export interface PolicyMoney {
  totalCents: number;
  installmentCents: number;
  installments: number;
  termDays: number;
}

/** The policy's economics in integer cents. */
export function policyMoney(p: PricingPolicy): PolicyMoney {
  return {
    totalCents: usdToCents(p.totalFeeUsd),
    installmentCents: usdToCents(p.billing.installmentUsd),
    installments: p.billing.installments,
    termDays: p.termDays,
  };
}

/** Structural invariants every policy entry must hold: the installments sum
 * exactly to the total, and the schedule has one entry per installment. */
export function validatePolicy(p: PricingPolicy): PricingPolicy {
  const m = policyMoney(p);
  if (m.installmentCents * m.installments !== m.totalCents) {
    throw new Error(`pricing policy ${p.version}: ${m.installments} × ${m.installmentCents} cents ≠ ${m.totalCents} cents`);
  }
  if (p.billing.schedule.length !== m.installments || p.billing.dueDayOffsets.length !== m.installments) {
    throw new Error(`pricing policy ${p.version}: schedule must list one entry per installment`);
  }
  if (p.performanceFee) {
    if (!(usdToCents(p.performanceFee.usd) > 0)) {
      throw new Error(`pricing policy ${p.version}: a performance fee must be greater than zero`);
    }
    if (!Number.isInteger(p.performanceFee.dueDaysAfterOutcome) || p.performanceFee.dueDaysAfterOutcome < 0) {
      throw new Error(`pricing policy ${p.version}: performance fee due days must be a non-negative whole number`);
    }
    if (p.performanceFee.condition !== PERFORMANCE_FEE_CONDITION) {
      throw new Error(`pricing policy ${p.version}: unknown performance fee condition`);
    }
  }
  return p;
}

/** Spec 152: the most the client can ever owe under a policy — fixed plus
 * performance fee. Only for places that must show a maximum, labelled as such;
 * never a contracted, expected or pipeline amount. */
export function maximumFeeUsd(p: PricingPolicy): number {
  return p.totalFeeUsd + (p.performanceFee?.usd ?? 0);
}

export interface Installment {
  /** 1-based. */
  n: number;
  amountUsd: number;
  amountCents: number;
  /** ISO date the installment is due. */
  dueOn: string;
  label: string;
}

/** Deterministic installment schedule from a start date (integer cents;
 * dates are start + policy day offsets). */
export function installmentSchedule(
  billing: BillingStructure,
  startsOn: string
): Installment[] {
  const base = new Date(`${startsOn}T00:00:00Z`);
  if (Number.isNaN(base.getTime())) throw new ClassifiedError("validation", `Invalid start date "${startsOn}".`);
  const amountCents = usdToCents(billing.installmentUsd);
  return billing.dueDayOffsets.map((offset, i) => {
    const d = new Date(base.getTime() + offset * 86_400_000);
    return {
      n: i + 1,
      amountUsd: billing.installmentUsd,
      amountCents,
      dueOn: d.toISOString().slice(0, 10),
      label: billing.schedule[i] ?? `installment ${i + 1}`,
    };
  });
}

const MONTHS_PER_YEAR = 12;
const DAYS_PER_MONTH = 30;

/** Operational run-rate semantics (spec 140). The monthly equivalent is what
 * one installment represents (monthly billing) or the fixed fee spread over
 * the term (any other cadence); the annualized figure is a RUN RATE — never
 * contracted or expected annual revenue, never a renewal assumption.
 * Spec 152: contracted money only — a performance fee is reported apart as
 * contingent and NOT CONTRACTED, and never enters the run rate. */
export interface RunRate {
  monthlyEquivalentUsd: number;
  annualizedRunRateUsd: number;
  annualizedLabel: "ANNUALIZED RUN RATE";
  contractedTotalUsd: number;
  contingentUsd: number;
  contingentLabel: "CONTINGENT — NOT CONTRACTED";
}
export function runRate(p: PricingPolicy): RunRate {
  const monthly =
    p.billing.cadence === "monthly"
      ? p.billing.installmentUsd
      : centsToUsd(Math.round((usdToCents(p.totalFeeUsd) * DAYS_PER_MONTH) / p.termDays));
  return {
    monthlyEquivalentUsd: monthly,
    annualizedRunRateUsd: centsToUsd(usdToCents(monthly) * MONTHS_PER_YEAR),
    annualizedLabel: "ANNUALIZED RUN RATE",
    contractedTotalUsd: p.totalFeeUsd,
    contingentUsd: p.performanceFee?.usd ?? 0,
    contingentLabel: "CONTINGENT — NOT CONTRACTED",
  };
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

/** "$7,500 / 90 days", or "$1,000 + $4,000 on target / 90 days" (spec 152).
 * Shared by policies, frozen quotes and engagements so every view agrees. */
export function formatOfferLabel(fixedUsd: number, termDays: number, performanceUsd: number | null | undefined): string {
  return performanceUsd ? `${usd(fixedUsd)} + ${usd(performanceUsd)} on target / ${termDays} days` : `${usd(fixedUsd)} / ${termDays} days`;
}

export function offerLabel(p: PricingPolicy = activePricingPolicy()): string {
  return formatOfferLabel(p.totalFeeUsd, p.termDays, p.performanceFee?.usd);
}

/** "$2,500 × 3", or "$1,000 at signing + $4,000 if target met" (spec 152). */
export function formatBillingLabel(b: { installments: number; installmentUsd: number; schedule: readonly string[] }, performanceUsd: number | null | undefined): string {
  const fixed = b.installments === 1 && b.schedule[0] ? `${usd(b.installmentUsd)} ${b.schedule[0]}` : `${usd(b.installmentUsd)} × ${b.installments}`;
  return performanceUsd ? `${fixed} + ${usd(performanceUsd)} if target met` : fixed;
}

export function billingLabel(p: PricingPolicy = activePricingPolicy()): string {
  return formatBillingLabel(p.billing, p.performanceFee?.usd);
}

/** Default engagement payment terms sentence for the sign dialog. */
export function paymentTermsDefault(p: PricingPolicy = activePricingPolicy()): string {
  if (p.performanceFee) {
    return `${usd(p.totalFeeUsd)} fixed fee for the ${p.termDays}-day engagement, invoiced ${p.billing.schedule.join(", ")}. Performance fee ${usd(p.performanceFee.usd)}, invoiced only when the agreed target is recorded as met and due ${p.performanceFee.dueDaysAfterOutcome} days after; not owed if the target is not met.`;
  }
  return `${usd(p.totalFeeUsd)} total for the ${p.termDays}-day engagement, invoiced ${billingLabel(p)}: ${p.billing.schedule.join(", ")}.`;
}

/** Which policy a sent body states, if any (markers are policy-specific). */
export function policyStatedIn(body: string): PricingPolicy | null {
  for (const p of PRICING_POLICIES) {
    if (p.offerMarkers.some((m) => body.includes(m))) return p;
  }
  return null;
}

/** The founder-ready answer to "what does it cost?" (docs/13-prompts.md).
 * Three sentences, no essay, no anchoring, no urgency. v1 renders the
 * fixed-fee policies (history); v2 renders a policy with a performance fee. */
export const PRICING_REPLY_TEMPLATE_V1 = "pricing_reply_v1";
export const PRICING_REPLY_TEMPLATE_V2 = "pricing_reply_v2";
/** The template the ACTIVE policy renders with. */
export const PRICING_REPLY_TEMPLATE_VERSION = PRICING_REPLY_TEMPLATE_V2;
export function pricingReplyTemplateVersion(p: PricingPolicy = activePricingPolicy()): string {
  return p.performanceFee ? PRICING_REPLY_TEMPLATE_V2 : PRICING_REPLY_TEMPLATE_V1;
}
export function pricingReplyLines(p: PricingPolicy = activePricingPolicy()): string[] {
  if (p.performanceFee) {
    const perf = usd(p.performanceFee.usd);
    return [
      `It's ${usd(p.totalFeeUsd)} to start, and ${perf} only if we hit a measurable target we agree on before we begin.`,
      `The target is measured by rerunning the same frozen set of ChatGPT questions after ${p.termDays} days.`,
      `If the target isn't reached, the ${perf} isn't owed.`,
    ];
  }
  return [
    `The ${p.termDays}-day engagement is ${usd(p.totalFeeUsd)}.`,
    "That includes the baseline, implementation of the highest-confidence changes, monitoring, and the comparable rerun at the end.",
    `We bill it as ${usd(p.billing.installmentUsd)} per month over the ${p.termDays} days.`,
  ];
}

export interface EngagementPricingInput {
  totalValueUsd: number;
  termDays: number;
  /** Spec 152: omitted = the policy's performance fee; null or 0 = none. */
  performanceFeeUsd?: number | null;
  priceOverrideReason?: string | null;
}

export interface ResolvedEngagementPricing {
  policyVersion: string;
  defaultTotalValueUsd: number;
  totalValueUsd: number;
  /** Spec 152: null when the engagement carries no performance fee. */
  defaultPerformanceFeeUsd: number | null;
  performanceFeeUsd: number | null;
  overrideReason: string | null;
}

/**
 * Engagement terms against the active policy: matching terms need no reason;
 * any other fixed fee, performance fee or term is a founder override and must
 * say why. The default is always recorded next to the actual, so an override
 * can be read later as exactly what it was.
 */
export function resolveEngagementPricing(input: EngagementPricingInput, p: PricingPolicy = activePricingPolicy()): ResolvedEngagementPricing {
  const reason = input.priceOverrideReason?.trim() || null;
  const defaultPerformance = p.performanceFee?.usd ?? null;
  const requested = input.performanceFeeUsd === undefined ? defaultPerformance : input.performanceFeeUsd;
  const performanceFeeUsd = requested && requested > 0 ? requested : null;
  const differs = input.totalValueUsd !== p.totalFeeUsd || input.termDays !== p.termDays || performanceFeeUsd !== defaultPerformance;
  if (differs && !reason) {
    throw new ClassifiedError(
      "validation",
      `Terms differ from the active offer (${offerLabel(p)}); a founder override reason is required. No silent discounting.`
    );
  }
  return {
    policyVersion: p.version,
    defaultTotalValueUsd: p.totalFeeUsd,
    totalValueUsd: input.totalValueUsd,
    defaultPerformanceFeeUsd: defaultPerformance,
    performanceFeeUsd,
    overrideReason: differs ? reason : null,
  };
}
