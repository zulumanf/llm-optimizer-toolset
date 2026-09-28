/**
 * Market control layer: ONE deterministic answer to "may outbound run in
 * this market?" for every geography in the RealTrends universe, not only
 * the launched ones.
 *
 * v2 (founder directive 2026-09-15, approved-market sprint): market
 * approval is a founder business decision recorded ONLY in the explicit
 * allowlist below. No metric — RealTrends density, production, brokerage
 * diversity, contact count, benchmark opportunity — may grant approval;
 * metrics may only PRIORITIZE an already-approved market. v1 derived
 * PROOF_BUILDING from "an unarchived launch exists", which let a scripted
 * launch (Chicago, Boston, Seattle, San Diego, …) open a market without a
 * founder decision. That authority is gone: a launch is the operational
 * container, the allowlist is the approval.
 *
 * Nothing here invents a classification. Every state is derived from an
 * existing founder decision or record:
 *   TIER_1_RESERVED          — the explicit reserved-market registry below
 *                              (founder directive 2026-09-11: NYC).
 *   ACTIVE_CLIENT_EXCLUSIVE  — a live exclusivity scope (spec 052) covers
 *                              the market.
 *   PAUSED                   — the market's launch is protected/paused/closed.
 *   RESEARCH_ONLY            — a launch exists but the market is NOT on the
 *                              founder allowlist: HOLD. Research, contact
 *                              enrichment and history stay; outbound does not.
 *   PROOF_BUILDING           — founder-approved AND an unarchived launch in
 *                              an outbound-capable status exists.
 *   APPROVED_UNLAUNCHED      — founder-approved, no launch yet: research and
 *                              contact work may proceed; outbound needs the
 *                              launch container first.
 *   UNCLASSIFIED             — no decision on record and no launch. HOLD.
 *   OPEN_FOR_SCALE           — defined for the model; never derived here
 *                              because no founder decision assigns it yet.
 *
 * Outbound is allowed ONLY in PROOF_BUILDING / OPEN_FOR_SCALE, and even
 * then every send-time gate (spec 052/062/120, cohort blockers) still runs.
 * Fail closed: an unknown state, a missing state code, or a market absent
 * from the allowlist is HOLD.
 */

export const MARKET_POLICY_STATES = [
  "PROOF_BUILDING",
  "APPROVED_UNLAUNCHED",
  "TIER_1_RESERVED",
  "ACTIVE_CLIENT_EXCLUSIVE",
  "OPEN_FOR_SCALE",
  "PAUSED",
  "RESEARCH_ONLY",
  "UNCLASSIFIED",
] as const;
export type MarketPolicyState = (typeof MARKET_POLICY_STATES)[number];

export const MARKET_POLICY_VERSION = "market-policy-v2";

/** Structural invariants this module and its tests enforce by name. */
export const MARKET_POLICY_INVARIANTS = [
  "MARKET_ALLOWLIST_REQUIRED",
  "NON_ALLOWLIST_CANNOT_OUTREACH",
  "TIER1_CANNOT_AUTO_APPROVE",
  "MARKET_METRICS_CANNOT_GRANT_APPROVAL",
  "ACTIVE_CLIENT_EXCLUSIVITY_WINS",
] as const;

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

/** The founder's explicit proof-building allowlist. This is the ONLY source
 * of market approval. Add or remove an entry only on a dated founder
 * decision; never from a metric, a script, or a launch. */
export interface ApprovedMarketEntry {
  city: string;
  stateCode: string;
}
export const FOUNDER_ALLOWLIST_SOURCE =
  "Founder allowlist 2026-09-15 (approved-market supply sprint): explicit proof-building markets; metrics rank, never approve.";
export const FOUNDER_APPROVED_PROOF_MARKETS: readonly ApprovedMarketEntry[] = [
  { city: "Raleigh", stateCode: "NC" },
  { city: "Reno", stateCode: "NV" },
  { city: "Virginia Beach", stateCode: "VA" },
  { city: "Colorado Springs", stateCode: "CO" },
  { city: "Greenville", stateCode: "SC" },
  { city: "St. Louis", stateCode: "MO" },
  { city: "Jersey City", stateCode: "NJ" },
  { city: "Wilmington", stateCode: "NC" },
  { city: "Wilmington", stateCode: "DE" },
  { city: "Annapolis", stateCode: "MD" },
  { city: "Charleston", stateCode: "SC" },
  { city: "Savannah", stateCode: "GA" },
  { city: "Princeton", stateCode: "NJ" },
  { city: "Omaha", stateCode: "NE" },
  { city: "Indianapolis", stateCode: "IN" },
  { city: "Cincinnati", stateCode: "OH" },
  { city: "Pittsburgh", stateCode: "PA" },
  { city: "Tucson", stateCode: "AZ" },
  { city: "Albuquerque", stateCode: "NM" },
  { city: "Kansas City", stateCode: "MO" },
  { city: "Columbus", stateCode: "OH" },
  { city: "Richmond", stateCode: "VA" },
  { city: "Chattanooga", stateCode: "TN" },
  { city: "Knoxville", stateCode: "TN" },
  { city: "Fort Collins", stateCode: "CO" },
  { city: "Jacksonville", stateCode: "FL" },
  { city: "Grand Rapids", stateCode: "MI" },
  { city: "Louisville", stateCode: "KY" },
  { city: "Birmingham", stateCode: "AL" },
  { city: "Huntsville", stateCode: "AL" },
  { city: "Boise", stateCode: "ID" },
  { city: "Spokane", stateCode: "WA" },
  { city: "Oklahoma City", stateCode: "OK" },
];

/** "St. Louis" / "St Louis" / "Saint Louis" are one city; nothing else is
 * normalized — the allowlist is matched on the market's own name or an
 * ancestor's, never on a fuzzy score. */
export function normalizeMarketName(name: string): string {
  return name.trim().toLowerCase().replace(/^saint\s+/, "st. ").replace(/^st\s+/, "st. ").replace(/\s+/g, " ");
}

/** MARKET_ALLOWLIST_REQUIRED: the allowlist entry covering this market, or
 * null. Fails closed when no state code is known — a bare "Wilmington" is
 * not approved for either state until its state is resolved. */
export function isFounderApprovedMarket(names: readonly string[], stateCode: string | null): ApprovedMarketEntry | null {
  if (!stateCode) return null;
  const state = stateCode.trim().toUpperCase();
  const lowered = names.map(normalizeMarketName);
  for (const entry of FOUNDER_APPROVED_PROOF_MARKETS) {
    if (entry.stateCode !== state) continue;
    if (lowered.includes(normalizeMarketName(entry.city))) return entry;
  }
  return null;
}

/** Launch statuses in which outbound is not running (market_launches CHECK). */
export const LAUNCH_BLOCKED_STATUSES = new Set(["protected", "paused", "closed"]);
/** Launch statuses that are outbound-capable containers. A launch in one of
 * these states no longer approves a market by itself (v2). */
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
  /** True only when the founder allowlist covers the market. Blocking
   * states (reserved, exclusive, paused) report false even when listed. */
  founderApproved: boolean;
  reasons: string[];
  version: typeof MARKET_POLICY_VERSION;
}

export const MARKET_NOT_FOUNDER_APPROVED = "MARKET_NOT_FOUNDER_APPROVED";

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

function hold(state: MarketPolicyState, reasons: string[], founderApproved = false): MarketPolicy {
  return { state, outboundAllowed: false, researchAllowed: true, founderApproved, reasons, version: MARKET_POLICY_VERSION };
}

/** Pure: the market's policy state from the facts on record. Fail closed —
 * any blocking signal wins over an opening one, and the allowlist is the
 * only opening signal. */
export function resolveMarketPolicy(f: MarketPolicyFacts): MarketPolicy {
  const reserved = isReservedMarket(f.names, f.stateCode);
  if (reserved) return hold("TIER_1_RESERVED", [reserved.source]);
  if (f.exclusiveScope) return hold("ACTIVE_CLIENT_EXCLUSIVE", ["A live exclusivity scope (spec 052) covers this market."]);
  if (f.launchStatus && LAUNCH_BLOCKED_STATUSES.has(f.launchStatus)) return hold("PAUSED", [`Launch status is ${f.launchStatus}.`]);
  const approved = isFounderApprovedMarket(f.names, f.stateCode);
  if (!approved) {
    const why = f.stateCode
      ? `${MARKET_NOT_FOUNDER_APPROVED}: not on the founder allowlist (${FOUNDER_ALLOWLIST_SOURCE}). No metric, launch or contact count can approve it.`
      : `${MARKET_NOT_FOUNDER_APPROVED}: no state code resolved for this market, so the allowlist cannot be matched (fail closed).`;
    if (f.launchStatus) return hold("RESEARCH_ONLY", [why, `An unarchived launch exists (status ${f.launchStatus}); it is HOLD — history, contacts and benchmarks are preserved, outbound is not eligible.`]);
    return hold("UNCLASSIFIED", [why]);
  }
  const source = `${approved.city}, ${approved.stateCode} is on the founder allowlist (${FOUNDER_ALLOWLIST_SOURCE}).`;
  if (f.launchStatus && LAUNCH_OUTBOUND_STATUSES.has(f.launchStatus)) {
    return { state: "PROOF_BUILDING", outboundAllowed: true, researchAllowed: true, founderApproved: true, reasons: [source, `Launch container exists (status ${f.launchStatus}).`], version: MARKET_POLICY_VERSION };
  }
  return hold("APPROVED_UNLAUNCHED", [source, "No launch container yet: open one before prospects can be created; outbound is not eligible until then."], true);
}

/** Hard gate for wave creation: outbound-eligible states only. */
export function outboundWaveEligible(policy: MarketPolicy): boolean {
  return policy.outboundAllowed && policy.founderApproved && (policy.state === "PROOF_BUILDING" || policy.state === "OPEN_FOR_SCALE");
}

/** OUTBOUND_MARKET_ALLOWED — the deterministic invariant every outbound
 * surface must satisfy: founder allowlist ∧ not active-client exclusive ∧
 * not paused ∧ no other canonical block. Returns the blocking reason codes
 * (empty = allowed). */
export function outboundMarketAllowed(f: MarketPolicyFacts): { allowed: boolean; state: MarketPolicyState; codes: string[] } {
  const p = resolveMarketPolicy(f);
  const codes: string[] = [];
  if (!isFounderApprovedMarket(f.names, f.stateCode)) codes.push(MARKET_NOT_FOUNDER_APPROVED);
  if (p.state === "TIER_1_RESERVED") codes.push("MARKET_TIER_1_RESERVED");
  if (p.state === "ACTIVE_CLIENT_EXCLUSIVE") codes.push("MARKET_EXCLUSIVE_CONFLICT");
  if (p.state === "PAUSED") codes.push("MARKET_PAUSED");
  if (p.state === "APPROVED_UNLAUNCHED") codes.push("MARKET_NOT_LAUNCHED");
  if (codes.length === 0 && !outboundWaveEligible(p)) codes.push("MARKET_POLICY_BLOCK");
  return { allowed: codes.length === 0, state: p.state, codes };
}
