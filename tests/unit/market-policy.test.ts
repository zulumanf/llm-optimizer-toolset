/**
 * Market control layer (supply engine 2026-09-13): every state derives from
 * a decision on record; nothing is invented and outbound fails closed.
 */
import { describe, expect, it } from "vitest";
import {
  MARKET_POLICY_STATES,
  PROTECTED_MARKET_NAMES,
  TIER_1_RESERVED_MARKETS,
  isReservedMarket,
  outboundWaveEligible,
  resolveMarketPolicy,
} from "@/lib/prospects/market-policy";
import { PROTECTED_MARKET_NAMES as COHORT_PROTECTED } from "@/lib/prospects/t1-cohort";

const base = { names: ["Reno"], stateCode: "NV", launchStatus: "researching", exclusiveScope: false };

describe("market policy states", () => {
  it("defines the five decision states plus UNCLASSIFIED", () => {
    expect([...MARKET_POLICY_STATES]).toEqual(["PROOF_BUILDING", "TIER_1_RESERVED", "ACTIVE_CLIENT_EXCLUSIVE", "OPEN_FOR_SCALE", "PAUSED", "UNCLASSIFIED"]);
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

describe("Tier-1 reserved (7, 8)", () => {
  it("NYC remains protected: not outbound-wave eligible even with a launch", () => {
    const p = resolveMarketPolicy({ ...base, names: ["New York City", "New York Metro", "United States"], stateCode: null });
    expect(p.state).toBe("TIER_1_RESERVED");
    expect(p.outboundAllowed).toBe(false);
    expect(outboundWaveEligible(p)).toBe(false);
  });

  it("protects a borough through its ancestor and by its RealTrends city name", () => {
    expect(resolveMarketPolicy({ ...base, names: ["Brooklyn Heights", "Brooklyn", "New York City"], stateCode: null }).state).toBe("TIER_1_RESERVED");
    expect(resolveMarketPolicy({ ...base, names: ["Manhattan"], stateCode: "NY", launchStatus: null }).state).toBe("TIER_1_RESERVED");
  });

  it("does not protect a same-named city in another state", () => {
    expect(isReservedMarket(["Manhattan"], "KS")).toBeNull();
    expect(resolveMarketPolicy({ ...base, names: ["Manhattan"], stateCode: "KS", launchStatus: null }).state).toBe("UNCLASSIFIED");
  });

  it("fails closed on the name when no state is declared", () => {
    expect(isReservedMarket(["New York"], null)).not.toBeNull();
  });
});

describe("blocking states (9, 10)", () => {
  it("active-client-exclusive market is excluded", () => {
    const p = resolveMarketPolicy({ ...base, exclusiveScope: true });
    expect(p.state).toBe("ACTIVE_CLIENT_EXCLUSIVE");
    expect(outboundWaveEligible(p)).toBe(false);
  });

  it("paused / protected / closed launch is excluded", () => {
    for (const status of ["paused", "protected", "closed"]) {
      const p = resolveMarketPolicy({ ...base, launchStatus: status });
      expect(p.state).toBe("PAUSED");
      expect(outboundWaveEligible(p)).toBe(false);
    }
  });

  it("a blocking signal wins over an opening one", () => {
    expect(resolveMarketPolicy({ ...base, exclusiveScope: true, launchStatus: "outreach_active" }).state).toBe("ACTIVE_CLIENT_EXCLUSIVE");
  });
});

describe("unclassified vs proof-building (11, 12)", () => {
  it("an unclassified market cannot auto-send but may be researched", () => {
    const p = resolveMarketPolicy({ ...base, names: ["Chicago"], stateCode: "IL", launchStatus: null });
    expect(p.state).toBe("UNCLASSIFIED");
    expect(p.outboundAllowed).toBe(false);
    expect(p.researchAllowed).toBe(true);
    expect(outboundWaveEligible(p)).toBe(false);
  });

  it("an allowed proof-building market can proceed", () => {
    const p = resolveMarketPolicy(base);
    expect(p.state).toBe("PROOF_BUILDING");
    expect(outboundWaveEligible(p)).toBe(true);
    expect(p.reasons[0]).toMatch(/launch/);
  });

  it("never derives OPEN_FOR_SCALE (no founder decision assigns it)", () => {
    const states = new Set([base, { ...base, launchStatus: null }, { ...base, launchStatus: "partner_selected" }].map((f) => resolveMarketPolicy(f).state));
    expect(states.has("OPEN_FOR_SCALE")).toBe(false);
  });
});
