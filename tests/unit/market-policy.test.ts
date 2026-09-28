/**
 * Market control layer v2 (founder directive 2026-09-15): approval is the
 * explicit founder allowlist and nothing else. Metrics rank; launches are
 * containers; everything not listed is HOLD. Outbound fails closed.
 */
import { describe, expect, it } from "vitest";
import {
  FOUNDER_APPROVED_PROOF_MARKETS,
  MARKET_POLICY_INVARIANTS,
  MARKET_POLICY_STATES,
  MARKET_POLICY_VERSION,
  PROTECTED_MARKET_NAMES,
  TIER_1_RESERVED_MARKETS,
  isFounderApprovedMarket,
  isReservedMarket,
  outboundMarketAllowed,
  outboundWaveEligible,
  resolveMarketPolicy,
} from "@/lib/prospects/market-policy";
import { PROTECTED_MARKET_NAMES as COHORT_PROTECTED } from "@/lib/prospects/t1-cohort";
import { marketExpansionClass } from "@/lib/prospects/supply-engine";

const base = { names: ["Reno"], stateCode: "NV", launchStatus: "researching", exclusiveScope: false };
const withLaunch = (names: string[], stateCode: string | null) => ({ names, stateCode, launchStatus: "researching", exclusiveScope: false });

describe("market policy registry", () => {
  it("defines the decision states, RESEARCH_ONLY hold and UNCLASSIFIED, at v2", () => {
    expect([...MARKET_POLICY_STATES]).toEqual(["PROOF_BUILDING", "APPROVED_UNLAUNCHED", "TIER_1_RESERVED", "ACTIVE_CLIENT_EXCLUSIVE", "OPEN_FOR_SCALE", "PAUSED", "RESEARCH_ONLY", "UNCLASSIFIED"]);
    expect(MARKET_POLICY_VERSION).toBe("market-policy-v2");
    expect([...MARKET_POLICY_INVARIANTS]).toEqual(["MARKET_ALLOWLIST_REQUIRED", "NON_ALLOWLIST_CANNOT_OUTREACH", "TIER1_CANNOT_AUTO_APPROVE", "MARKET_METRICS_CANNOT_GRANT_APPROVAL", "ACTIVE_CLIENT_EXCLUSIVITY_WINS"]);
  });

  it("the founder allowlist has exactly the 33 approved city/state pairs, no duplicates", () => {
    expect(FOUNDER_APPROVED_PROOF_MARKETS).toHaveLength(33);
    const keys = FOUNDER_APPROVED_PROOF_MARKETS.map((e) => `${e.city.toLowerCase()}|${e.stateCode}`);
    expect(new Set(keys).size).toBe(33);
    for (const e of FOUNDER_APPROVED_PROOF_MARKETS) expect(e.stateCode).toMatch(/^[A-Z]{2}$/);
    expect(keys).toContain("wilmington|NC");
    expect(keys).toContain("wilmington|DE");
    expect(keys).not.toContain("chicago|IL");
    expect(keys).not.toContain("seattle|WA");
  });

  it("seeds only NYC as reserved, with a dated founder source", () => {
    expect(TIER_1_RESERVED_MARKETS).toHaveLength(1);
    expect(TIER_1_RESERVED_MARKETS[0]!.source).toMatch(/2026-09-11/);
    expect(TIER_1_RESERVED_MARKETS[0]!.stateCode).toBe("NY");
  });

  it("keeps the cohort module on the same registry (one source of truth)", () => {
    expect(COHORT_PROTECTED).toBe(PROTECTED_MARKET_NAMES);
    expect(PROTECTED_MARKET_NAMES).toContain("new york city");
  });
});

describe("regression 1–4: previously auto-approved markets cannot auto-approve", () => {
  for (const [city, state] of [["Chicago", "IL"], ["Boston", "MA"], ["Seattle", "WA"], ["San Diego", "CA"]] as const) {
    it(`${city} with an unarchived launch is RESEARCH_ONLY (HOLD), never PROOF_BUILDING`, () => {
      const p = resolveMarketPolicy(withLaunch([city], state));
      expect(p.state).toBe("RESEARCH_ONLY");
      expect(p.founderApproved).toBe(false);
      expect(p.outboundAllowed).toBe(false);
      expect(p.researchAllowed).toBe(true);
      expect(outboundWaveEligible(p)).toBe(false);
      expect(p.reasons[0]).toMatch(/MARKET_NOT_FOUNDER_APPROVED/);
      expect(outboundMarketAllowed(withLaunch([city], state)).codes).toContain("MARKET_NOT_FOUNDER_APPROVED");
    });
  }
  it("every outbound-capable launch status is still HOLD off-list", () => {
    for (const status of ["researching", "benchmarking", "outreach_ready", "outreach_active", "in_conversation", "partner_selected"]) {
      expect(resolveMarketPolicy({ ...withLaunch(["Boston"], "MA"), launchStatus: status }).outboundAllowed).toBe(false);
    }
  });
});

describe("regression 5–7: NYC, Los Angeles and unknown markets cannot outbound", () => {
  it("5: NYC and its boroughs stay TIER_1_RESERVED (TIER1_CANNOT_AUTO_APPROVE)", () => {
    for (const names of [["New York City", "New York Metro", "United States"], ["Manhattan"], ["Brooklyn Heights", "Brooklyn", "New York City"]]) {
      const p = resolveMarketPolicy(withLaunch(names, "NY"));
      expect(p.state).toBe("TIER_1_RESERVED");
      expect(p.founderApproved).toBe(false);
      expect(outboundWaveEligible(p)).toBe(false);
    }
    expect(resolveMarketPolicy({ ...base, names: ["New York City"], stateCode: null }).state).toBe("TIER_1_RESERVED");
  });
  it("6: Los Angeles (and other premium metros) are HOLD", () => {
    for (const [city, state] of [["Los Angeles", "CA"], ["San Francisco", "CA"], ["Beverly Hills", "CA"], ["Newport Beach", "CA"], ["Washington", "DC"]] as const) {
      expect(resolveMarketPolicy({ ...base, names: [city], stateCode: state, launchStatus: null }).outboundAllowed).toBe(false);
      expect(resolveMarketPolicy(withLaunch([city], state)).outboundAllowed).toBe(false);
    }
  });
  it("7: an unknown market, or one with no resolvable state, is UNCLASSIFIED / HOLD (fail closed)", () => {
    const unknown = resolveMarketPolicy({ ...base, names: ["Nowhere"], stateCode: "ZZ", launchStatus: null });
    expect(unknown.state).toBe("UNCLASSIFIED");
    expect(unknown.outboundAllowed).toBe(false);
    expect(isFounderApprovedMarket(["Wilmington"], null)).toBeNull();
    const noState = resolveMarketPolicy(withLaunch(["Wilmington"], null));
    expect(noState.state).toBe("RESEARCH_ONLY");
    expect(noState.reasons[0]).toMatch(/no state code/);
  });
  it("does not protect a same-named city in another state", () => {
    expect(isReservedMarket(["Manhattan"], "KS")).toBeNull();
    expect(resolveMarketPolicy({ ...base, names: ["Manhattan"], stateCode: "KS", launchStatus: null }).state).toBe("UNCLASSIFIED");
  });
});

describe("regression 8–10: approved markets can proceed", () => {
  it("8: Raleigh, NC with a launch is PROOF_BUILDING and wave-eligible", () => {
    const p = resolveMarketPolicy(withLaunch(["Raleigh", "North Carolina", "United States"], "NC"));
    expect(p.state).toBe("PROOF_BUILDING");
    expect(p.founderApproved).toBe(true);
    expect(outboundWaveEligible(p)).toBe(true);
    expect(outboundMarketAllowed(withLaunch(["Raleigh"], "NC"))).toMatchObject({ allowed: true, codes: [] });
  });
  it("9: Omaha, NE is approved; without a launch it is APPROVED_UNLAUNCHED (research yes, outbound after the container exists)", () => {
    const p = resolveMarketPolicy({ ...base, names: ["Omaha"], stateCode: "NE", launchStatus: null });
    expect(p.state).toBe("APPROVED_UNLAUNCHED");
    expect(p.founderApproved).toBe(true);
    expect(p.researchAllowed).toBe(true);
    expect(p.outboundAllowed).toBe(false);
    expect(outboundMarketAllowed({ ...base, names: ["Omaha"], stateCode: "NE", launchStatus: null }).codes).toEqual(["MARKET_NOT_LAUNCHED"]);
    expect(resolveMarketPolicy(withLaunch(["Omaha"], "NE")).state).toBe("PROOF_BUILDING");
  });
  it("10: Wilmington is approved for NC and DE separately — state decides, never the bare name", () => {
    expect(resolveMarketPolicy(withLaunch(["Wilmington"], "NC")).state).toBe("PROOF_BUILDING");
    expect(resolveMarketPolicy(withLaunch(["Wilmington"], "DE")).state).toBe("PROOF_BUILDING");
    expect(resolveMarketPolicy(withLaunch(["Wilmington"], "OH")).state).toBe("RESEARCH_ONLY");
    // A sub-market (zip) under Wilmington, DE inherits the approval through its ancestor.
    expect(resolveMarketPolicy(withLaunch(["19803", "Wilmington", "Delaware"], "DE")).state).toBe("PROOF_BUILDING");
  });
  it("every allowlisted market resolves as founder-approved, and St. Louis spelling variants match", () => {
    for (const e of FOUNDER_APPROVED_PROOF_MARKETS) expect(isFounderApprovedMarket([e.city], e.stateCode)?.city).toBe(e.city);
    expect(isFounderApprovedMarket(["Saint Louis"], "MO")).not.toBeNull();
    expect(isFounderApprovedMarket(["St Louis"], "MO")).not.toBeNull();
    expect(isFounderApprovedMarket(["st. louis"], "mo")).not.toBeNull();
  });
});

describe("regression 11–12: metrics cannot bypass the allowlist (MARKET_METRICS_CANNOT_GRANT_APPROVAL)", () => {
  const dense = { teams: 600, individuals: 1200, highProduction: 231, teams100m: 40, brokerageDiversity: 32, namedLeads: 200 };
  it("11: market density never approves — Chicago-scale supply is HOLD_NOT_FOUNDER_APPROVED", () => {
    const r = marketExpansionClass({ ...dense, policyState: "RESEARCH_ONLY", founderApproved: false });
    expect(r.klass).toBe("HOLD_NOT_FOUNDER_APPROVED");
    expect(r.priority).toBeNull();
    expect(marketExpansionClass({ ...dense, policyState: "UNCLASSIFIED", founderApproved: false }).klass).toBe("HOLD_NOT_FOUNDER_APPROVED");
  });
  it("12: contact count / brokerage diversity never approve, and Tier-1 stays reserved regardless of value", () => {
    expect(marketExpansionClass({ ...dense, namedLeads: 5000, brokerageDiversity: 500, policyState: "UNCLASSIFIED", founderApproved: false }).klass).toBe("HOLD_NOT_FOUNDER_APPROVED");
    expect(marketExpansionClass({ ...dense, policyState: "TIER_1_RESERVED", founderApproved: false }).klass).toBe("HOLD_TIER_1_RESERVED");
  });
  it("metrics only rank approved markets: a thin approved market still ranks, a rich one ranks higher", () => {
    const thin = marketExpansionClass({ policyState: "PROOF_BUILDING", founderApproved: true, teams: 10, individuals: 20, highProduction: 5, teams100m: 0, brokerageDiversity: 3, namedLeads: 4 });
    const rich = marketExpansionClass({ ...dense, policyState: "PROOF_BUILDING", founderApproved: true });
    expect(thin.klass).toBe("APPROVED_PRIORITY");
    expect(rich.klass).toBe("APPROVED_PRIORITY");
    expect(rich.priority!).toBeGreaterThan(thin.priority!);
  });
});

describe("blocking states win over the allowlist (ACTIVE_CLIENT_EXCLUSIVITY_WINS)", () => {
  it("active-client-exclusive approved market is excluded", () => {
    const p = resolveMarketPolicy({ ...base, exclusiveScope: true });
    expect(p.state).toBe("ACTIVE_CLIENT_EXCLUSIVE");
    expect(p.founderApproved).toBe(false);
    expect(outboundWaveEligible(p)).toBe(false);
    expect(outboundMarketAllowed({ ...base, exclusiveScope: true }).codes).toContain("MARKET_EXCLUSIVE_CONFLICT");
  });
  it("paused / protected / closed launch on an approved market is excluded", () => {
    for (const status of ["paused", "protected", "closed"]) {
      const p = resolveMarketPolicy({ ...base, launchStatus: status });
      expect(p.state).toBe("PAUSED");
      expect(outboundWaveEligible(p)).toBe(false);
    }
  });
  it("a blocking signal wins over an opening one", () => {
    expect(resolveMarketPolicy({ ...base, exclusiveScope: true, launchStatus: "outreach_active" }).state).toBe("ACTIVE_CLIENT_EXCLUSIVE");
  });
  it("never derives OPEN_FOR_SCALE (no founder decision assigns it)", () => {
    const states = new Set([base, { ...base, launchStatus: null }, { ...base, launchStatus: "partner_selected" }].map((f) => resolveMarketPolicy(f).state));
    expect(states.has("OPEN_FOR_SCALE")).toBe(false);
  });
});
