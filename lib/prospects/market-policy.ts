/**
 * Market control layer (supply engine, 2026-09-13): ONE deterministic
 * answer to "may outbound run in this market?" for every geography in the
 * RealTrends universe, not only the launched ones.
 *
 * Nothing here invents a classification. Every state is derived from an
 * existing founder decision or record:
 *   TIER_1_RESERVED          — the explicit reserved-market registry below
 *                              (founder directive 2026-09-11: NYC).
 *   ACTIVE_CLIENT_EXCLUSIVE  — a live exclusivity scope (spec 052) covers
 *                              the market.
 *   PAUSED                   — the market's launch is protected/paused/closed.
 *   PROOF_BUILDING           — an unarchived launch in an outbound-capable
 *                              status exists; launch kickoff is the
 *                              confirm-gated founder act that opens a market.
 *   UNCLASSIFIED             — no decision on record. Research allowed,
 *                              outbound NOT allowed until a launch exists.
 *   OPEN_FOR_SCALE           — defined for the model; never derived here
 *                              because no founder decision assigns it yet.
 *
 * Outbound is allowed ONLY in PROOF_BUILDING / OPEN_FOR_SCALE, and even
 * then every send-time gate (spec 052/062/120, cohort blockers) still runs.
 */

export const MARKET_POLICY_STATES = [
  "PROOF_BUILDING",
  "TIER_1_RESERVED",
  "ACTIVE_CLIENT_EXCLUSIVE",
  "OPEN_FOR_SCALE",
  "PAUSED",
  "UNCLASSIFIED",
] as const;
export type MarketPolicyState = (typeof MARKET_POLICY_STATES)[number];

export const MARKET_POLICY_VERSION = "market-policy-v1";

/** Reserved ("Tier-1") markets. Seeded ONLY from explicit founder
 * directives on record; add an entry only with a dated source. Matching is
 * on the lowered market name (or any ancestor's) plus the state code when
 * the entry names one — "Manhattan, KS" is not New York. */
export interface ReservedMarketEntry {
  names: readonly string[];
  stateCode: string | null;
  source: string;
}
export const TIER_1_RESERVED_MARKETS: readonly ReservedMarketEntry[] = [
  {
    // The city and its boroughs are one commercial territory: the market
    // tree files every borough under "New York City", and RealTrends files
    // the same entities under "New York", "Manhattan" and "Brooklyn".
    names: ["new york city", "nyc", "new york", "manhattan", "brooklyn", "queens", "the bronx", "bronx", "staten island"],
    stateCode: "NY",
    source: "Founder directive 2026-09-11 (t1-cohort-002): NYC is never placed in an outbound cohort; boroughs per the market tree under New York City.",
  },
];

/** Backwards-compatible name list (t1-cohort-002 used a bare-name match). */
export const PROTECTED_MARKET_NAMES: readonly string[] = TIER_1_RESERVED_MARKETS.flatMap((e) => e.names);

/** Launch statuses in which outbound is not running (market_launches CHECK). */
export const LAUNCH_BLOCKED_STATUSES = new Set(["protected", "paused", "closed"]);
/** Launch statuses in which the founder has opened the market for proof-building outreach. */
export const LAUNCH_OUTBOUND_STATUSES = new Set(["researching", "benchmarking", "outreach_ready", "outreach_active", "in_conversation", "partner_selected"]);

export interface MarketPolicyFacts {
  /** The market's own name plus every ancestor name (lowered or not). */
  names: readonly string[];
  stateCode: string | null;
  /** Status of the unarchived launch for this market, if any. */
  launchStatus: string | null;
  /** True when a live (active/reserved) exclusivity scope covers the market. */
  exclusiveScope: boolean;
}

export interface MarketPolicy {
  state: MarketPolicyState;
  outboundAllowed: boolean;
  researchAllowed: boolean;
  reasons: string[];
  version: typeof MARKET_POLICY_VERSION;
}

export function isReservedMarket(names: readonly string[], stateCode: string | null): ReservedMarketEntry | null {
  const lowered = names.map((n) => n.trim().toLowerCase());
  for (const entry of TIER_1_RESERVED_MARKETS) {
    const nameHit = lowered.some((n) => entry.names.includes(n));
    if (!nameHit) continue;
    // A state on the entry must match when the market declares one; a
    // market with no declared state still fails closed on the name.
    if (entry.stateCode && stateCode && stateCode !== entry.stateCode) continue;
    return entry;
  }
  return null;
}

/** Pure: the market's policy state from the facts on record. Fail closed —
 * any blocking signal wins over an opening one. */
export function resolveMarketPolicy(f: MarketPolicyFacts): MarketPolicy {
  const reserved = isReservedMarket(f.names, f.stateCode);
  if (reserved) {
    return { state: "TIER_1_RESERVED", outboundAllowed: false, researchAllowed: true, reasons: [reserved.source], version: MARKET_POLICY_VERSION };
  }
  if (f.exclusiveScope) {
    return { state: "ACTIVE_CLIENT_EXCLUSIVE", outboundAllowed: false, researchAllowed: true, reasons: ["A live exclusivity scope (spec 052) covers this market."], version: MARKET_POLICY_VERSION };
  }
  if (f.launchStatus && LAUNCH_BLOCKED_STATUSES.has(f.launchStatus)) {
    return { state: "PAUSED", outboundAllowed: false, researchAllowed: true, reasons: [`Launch status is ${f.launchStatus}.`], version: MARKET_POLICY_VERSION };
  }
  if (f.launchStatus && LAUNCH_OUTBOUND_STATUSES.has(f.launchStatus)) {
    return { state: "PROOF_BUILDING", outboundAllowed: true, researchAllowed: true, reasons: [`An unarchived launch exists (status ${f.launchStatus}); launch kickoff is the confirm-gated founder act that opens a market.`], version: MARKET_POLICY_VERSION };
  }
  return {
    state: "UNCLASSIFIED",
    outboundAllowed: false,
    researchAllowed: true,
    reasons: ["No founder decision on record for this market: research and benchmark planning may proceed; outbound requires a launch (founder approval)."],
    version: MARKET_POLICY_VERSION,
  };
}

/** Hard gate for wave creation: outbound-eligible states only. */
export function outboundWaveEligible(policy: MarketPolicy): boolean {
  return policy.outboundAllowed && (policy.state === "PROOF_BUILDING" || policy.state === "OPEN_FOR_SCALE");
}
