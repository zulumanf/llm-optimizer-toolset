/**
 * Touch 1 supply engine (2026-09-13) — the pure-layer gate matrix: universe
 * normalization, prequalification, contactability, wave sizing/JIT, and the
 * qualification-vs-dispatch split. Spec 124/136 gates are tested in their
 * own suites (mismatch, evidence-release) and only reused here.
 */
import { describe, expect, it } from "vitest";
import { BROKERAGE_SEND_CAP_30D, MISMATCH_THRESHOLDS } from "@/lib/prospects/constants";
import { resolveMarketPolicy } from "@/lib/prospects/market-policy";
import {
  OBSERVED_FUNNEL,
  PREMIUM_RESERVE_TEAMS_100M,
  marketExpansionClass,
  SUPPLY_STAGES,
  benchmarkFreshness,
  brokerageCapFreeAt,
  contactability,
  dispatchPlan,
  marketBand,
  normalizeSourceRecords,
  planWaves,
  prequalify,
  rankMarkets,
  supplyMetrics,
  waveSizing,
  type CanonicalCandidate,
  type ExistingProspectState,
  type MarketSupplyFeatures,
  type SourceRecord,
} from "@/lib/prospects/supply-engine";

const NOW = new Date("2026-09-13T12:00:00Z");
const DAY = 86_400_000;

function rec(over: Partial<SourceRecord> = {}): SourceRecord {
  return { id: "r1", fingerprint: "f1", entityType: "team", entityName: "Hodges Group", teamLead: "Jessica Hodges", brokerage: "Real Broker", city: "Reno", state: "NV", volumeUsd: 80_000_000, sides: 120, productionYear: 2025, companyId: null, matchStatus: "unmatched", ...over };
}
const proof = resolveMarketPolicy({ names: ["Reno"], stateCode: "NV", launchStatus: "researching", exclusiveScope: false });
const reserved = resolveMarketPolicy({ names: ["New York City"], stateCode: "NY", launchStatus: "researching", exclusiveScope: false });
const unclassified = resolveMarketPolicy({ names: ["Chicago"], stateCode: "IL", launchStatus: null, exclusiveScope: false });
const untouched: ExistingProspectState = { prospectId: "p1", stage: "identified", contacted: false, activeSequence: false, positiveReply: false, engagement: false, declined: false, doNotContact: false, suppressed: false };
function cand(over: Partial<CanonicalCandidate> = {}): CanonicalCandidate {
  return normalizeSourceRecords([rec()]).map((c) => ({ ...c, ...over }))[0]!;
}

describe("universe normalization (1–6)", () => {
  it("normalizes source records that are not prospects (universe is not bounded by prospect rows)", () => {
    const out = normalizeSourceRecords([rec({ companyId: null })]);
    expect(out).toHaveLength(1);
    expect(out[0]!.canonicalEntityId).toBe("r1");
    expect(out[0]!.status).toBe("CANONICAL");
  });

  it("preserves source provenance and uses the linked company as canonical id", () => {
    const c = normalizeSourceRecords([rec({ companyId: "co-1" })])[0]!;
    expect(c).toMatchObject({ sourceRecordId: "r1", fingerprint: "f1", canonicalEntityId: "co-1", productionYear: 2025, productionMetric: "volume_usd", productionValue: 80_000_000, teamLead: "Jessica Hodges", brokerage: "Real Broker" });
  });

  it("collapses an exact duplicate but fails closed on conflicting production", () => {
    const exact = normalizeSourceRecords([rec({ id: "a" }), rec({ id: "b" })]).map((c) => c.status);
    expect(exact.sort()).toEqual(["CANONICAL", "EXACT_DUPLICATE"]);
    const ambiguous = normalizeSourceRecords([rec({ id: "a" }), rec({ id: "b", volumeUsd: 70_000_000 })]).map((c) => c.status);
    expect(ambiguous).toEqual(["AMBIGUOUS_DUPLICATE", "AMBIGUOUS_DUPLICATE"]);
  });

  it("marks the team lead's individual row as the same buying unit only via the team's stated lead", () => {
    const out = normalizeSourceRecords([rec(), rec({ id: "i1", entityType: "individual", entityName: "Jessica Hodges", teamLead: null })]);
    const lead = out.find((c) => c.sourceRecordId === "i1")!;
    expect(lead.status).toBe("SAME_BUYING_UNIT_AS_TEAM");
    expect(lead.buyingUnitOf).toBe("r1");
    // Same name in another city: no provenance, no merge.
    const other = normalizeSourceRecords([rec(), rec({ id: "i2", entityType: "individual", entityName: "Jessica Hodges", city: "Sparks" })]);
    expect(other.find((c) => c.sourceRecordId === "i2")!.status).toBe("CANONICAL");
  });

  it("keeps agent and team levels distinct even with the same name", () => {
    const out = normalizeSourceRecords([rec({ id: "t", entityName: "Smith" }), rec({ id: "i", entityType: "individual", entityName: "Smith", teamLead: null })]);
    expect(out.map((c) => c.status)).toEqual(["CANONICAL", "CANONICAL"]);
  });

  it("an unknown / non-canonical entity never prequalifies", () => {
    expect(prequalify({ candidate: cand({ status: "AMBIGUOUS_DUPLICATE" }), policy: proof, exclusiveConflict: false, existing: null })).toContain("SOURCE_NOT_CANONICAL");
    expect(prequalify({ candidate: cand({ productionValue: null }), policy: proof, exclusiveConflict: false, existing: null })).toContain("PRODUCTION_MISSING");
  });
});

describe("prequalification (13–18)", () => {
  const base = { candidate: cand(), policy: proof, exclusiveConflict: false };
  it("excludes prior-contacted, positive responders, clients, DNC, suppressed, declined, active sequences", () => {
    expect(prequalify({ ...base, existing: { ...untouched, contacted: true, stage: "contacted" } })).toEqual(expect.arrayContaining(["ALREADY_CONTACTED", "STAGE_NOT_FIRST_TOUCH"]));
    expect(prequalify({ ...base, existing: { ...untouched, positiveReply: true } })).toContain("POSITIVE_RESPONDER");
    expect(prequalify({ ...base, existing: { ...untouched, engagement: true } })).toContain("CLIENT_OR_ENGAGEMENT");
    expect(prequalify({ ...base, existing: { ...untouched, doNotContact: true } })).toContain("DO_NOT_CONTACT");
    expect(prequalify({ ...base, existing: { ...untouched, suppressed: true } })).toContain("SUPPRESSED");
    expect(prequalify({ ...base, existing: { ...untouched, declined: true } })).toContain("DECLINED");
    expect(prequalify({ ...base, existing: { ...untouched, activeSequence: true } })).toContain("ACTIVE_SEQUENCE");
  });

  it("a valid untouched entity is eligible, tracked or not", () => {
    expect(prequalify({ ...base, existing: null })).toEqual([]);
    expect(prequalify({ ...base, existing: untouched })).toEqual([]);
  });

  it("market policy and exclusivity are hard gates", () => {
    expect(prequalify({ ...base, policy: reserved, existing: null })).toContain("MARKET_OUTBOUND_BLOCKED");
    expect(prequalify({ ...base, policy: unclassified, existing: null })).toContain("MARKET_OUTBOUND_BLOCKED");
    expect(prequalify({ ...base, exclusiveConflict: true, existing: null })).toContain("EXCLUSIVITY_CONFLICT");
  });
});

describe("contactability (19–24)", () => {
  it("verified and publicly sourced direct contacts pass", () => {
    expect(contactability({ email: "jess@homeisnv.com", provenance: "verified", researched: true })).toBe("CONTACT_VERIFIED");
    expect(contactability({ email: "jess@homeisnv.com", provenance: "publicly_sourced", researched: true })).toBe("CONTACT_VERIFIED");
  });

  it("guessed, AI-inferred, estimated or manual-unverified emails fail", () => {
    for (const provenance of ["ai_inferred", "estimated", "manual", null]) {
      expect(contactability({ email: "jess@homeisnv.com", provenance, researched: true })).toBe("CONTACT_UNVERIFIED");
    }
  });

  it("a generic inbox is not a decision-maker contact", () => {
    expect(contactability({ email: "info@homeisnv.com", provenance: "publicly_sourced", researched: true })).toBe("GENERIC_ONLY");
  });

  it("missing contact is research-required until a sourcing pass ran, then no-contact-found", () => {
    expect(contactability(null)).toBe("CONTACT_RESEARCH_REQUIRED");
    expect(contactability({ email: null, provenance: null, researched: false })).toBe("CONTACT_RESEARCH_REQUIRED");
    expect(contactability({ email: null, provenance: null, researched: true })).toBe("NO_CONTACT_FOUND");
  });
});

function market(over: Partial<MarketSupplyFeatures> = {}): MarketSupplyFeatures {
  return { marketKey: "reno|NV", city: "Reno", state: "NV", policy: proof, launchId: "l1", sourceEntities: 180, teams: 60, individuals: 120, highProduction: 11, prequalified: 40, prequalifiedAboveFloor: 40, prequalifiedBrokerages: 12, contactVerified: 0, contactResearchRequired: 40, contactedDensity: 0.2, benchmark: { status: "NONE", capturedAt: null, expiresAt: null, runId: null }, positiveHistory: 0, clientHistory: 0, ...over };
}

describe("wave sizing and just-in-time benchmarking (24–30)", () => {
  it("derives wave sizes from constants and the observed funnel, never a hand-picked number", () => {
    const s = waveSizing();
    const y = (OBSERVED_FUNNEL.mismatchEligible / OBSERVED_FUNNEL.firstTouch) * (OBSERVED_FUNNEL.evidenceVerified / OBSERVED_FUNNEL.mismatchEligible);
    expect(s.yieldPerContactVerified).toBeCloseTo(y, 6);
    expect(s.minContactVerified).toBe(Math.ceil(1 / y));
    expect(s.targetContactVerified).toBe(Math.ceil(BROKERAGE_SEND_CAP_30D / y));
  });

  it("missing contacts prevent a fresh benchmark by default (JIT not triggered)", () => {
    const [w] = planWaves(rankMarkets([market({ contactVerified: waveSizing().minContactVerified - 1 })]));
    expect(w!.jitTriggered).toBe(false);
    expect(w!.benchmarkAction).toBe("RUN_WHEN_CONTACT_READY");
    expect(w!.contactsShortOfMinimum).toBe(1);
  });

  it("enough verified contacts trigger a run; a stale benchmark becomes a refresh", () => {
    const min = waveSizing().minContactVerified;
    expect(planWaves(rankMarkets([market({ contactVerified: min })]))[0]!.benchmarkAction).toBe("RUN_NOW");
    const stale = { status: "STALE" as const, capturedAt: new Date(NOW.getTime() - 20 * DAY), expiresAt: new Date(NOW.getTime() - 6 * DAY), runId: "run" };
    expect(planWaves(rankMarkets([market({ contactVerified: min, benchmark: stale })]))[0]!.benchmarkAction).toBe("REFRESH_NOW");
    expect(planWaves(rankMarkets([market({ contactVerified: 0, benchmark: stale })]))[0]!.benchmarkAction).toBe("REFRESH_WHEN_CONTACT_READY");
  });

  it("a fresh benchmark is reused, never duplicated by a second wave", () => {
    const fresh = { status: "FRESH" as const, capturedAt: new Date(NOW.getTime() - DAY), expiresAt: new Date(NOW.getTime() + 13 * DAY), runId: "run" };
    const [w] = planWaves(rankMarkets([market({ benchmark: fresh })]));
    expect(w!.benchmarkAction).toBe("REUSE_FRESH");
    expect(w!.jitTriggered).toBe(true);
  });

  it("benchmark freshness follows MISMATCH_THRESHOLDS.maxBenchmarkAgeDays exactly", () => {
    const captured = new Date(NOW.getTime() - MISMATCH_THRESHOLDS.maxBenchmarkAgeDays * DAY);
    expect(benchmarkFreshness(captured, NOW).status).toBe("FRESH");
    expect(benchmarkFreshness(new Date(captured.getTime() - 1), NOW).status).toBe("STALE");
    expect(benchmarkFreshness(null, NOW)).toEqual({ status: "NONE", expiresAt: null });
  });

  it("wave planning is market-scoped and blocked markets never get a wave (7, 9, 11, 30)", () => {
    const waves = planWaves(rankMarkets([market(), market({ marketKey: "new york|NY", city: "New York", state: "NY", policy: reserved }), market({ marketKey: "chicago|IL", city: "Chicago", state: "IL", policy: unclassified })]));
    expect(waves.map((w) => w.marketKey)).toEqual(["reno|NV"]);
    // A wave carries no send instruction of any kind.
    expect(Object.keys(waves[0]!)).not.toEqual(expect.arrayContaining(["send", "schedule", "draft"]));
  });
});

describe("market bands are transparent rankings", () => {
  it("HOLD only restates a policy block or an empty pool", () => {
    expect(marketBand(market({ policy: reserved })).band).toBe("HOLD");
    expect(marketBand(market({ prequalified: 2 })).band).toBe("HOLD");
  });

  it("A+ needs depth, brokerage diversity and reusable evidence or verified contacts; every band carries reasons", () => {
    const fresh = { status: "FRESH" as const, capturedAt: NOW, expiresAt: new Date(NOW.getTime() + 14 * DAY), runId: "run" };
    const aPlus = marketBand(market({ benchmark: fresh }));
    expect(aPlus.band).toBe("A+");
    expect(aPlus.reasons.length).toBeGreaterThanOrEqual(3);
    expect(marketBand(market({ prequalified: 10, prequalifiedAboveFloor: 10, prequalifiedBrokerages: 4, contactVerified: 8 })).band).toBe("A");
    expect(marketBand(market({ prequalified: 10, prequalifiedAboveFloor: 10, prequalifiedBrokerages: 2 })).band).toBe("B");
  });
});

describe("qualification vs dispatch (40–44)", () => {
  const sends = (n: number) => Array.from({ length: n }, (_, i) => new Date(NOW.getTime() - (i + 1) * DAY));

  it("the brokerage cap frees at the oldest counted send + 30 days, and is free below the cap", () => {
    expect(brokerageCapFreeAt(sends(BROKERAGE_SEND_CAP_30D - 1), NOW)).toEqual(NOW);
    const free = brokerageCapFreeAt(sends(BROKERAGE_SEND_CAP_30D), NOW);
    expect(free).toEqual(new Date(NOW.getTime() - BROKERAGE_SEND_CAP_30D * DAY + 30 * DAY));
  });

  it("a cap creates a deferred-qualified state with a next date; it never erases qualification", () => {
    const plan = dispatchPlan({ benchmarkCapturedAt: new Date(NOW.getTime() - 10 * DAY), capFreeAt: new Date(NOW.getTime() + 20 * DAY), now: NOW, blockingPolicy: "BROKERAGE_SEND_CAP_30D" });
    expect(plan.status).toBe("DEFERRED_QUALIFIED");
    expect(plan.blockingPolicy).toBe("BROKERAGE_SEND_CAP_30D");
    expect(plan.nextEligibleSendAt).toEqual(new Date(NOW.getTime() + 20 * DAY));
  });

  it("a next-send date after benchmark expiry requires a just-in-time refresh", () => {
    const captured = new Date(NOW.getTime() - 10 * DAY);
    const late = dispatchPlan({ benchmarkCapturedAt: captured, capFreeAt: new Date(NOW.getTime() + 20 * DAY), now: NOW, blockingPolicy: "cap" });
    expect(late.benchmarkExpiresAt).toEqual(new Date(captured.getTime() + MISMATCH_THRESHOLDS.maxBenchmarkAgeDays * DAY));
    expect(late.refreshRequiredBeforeSend).toBe(true);
    const soon = dispatchPlan({ benchmarkCapturedAt: captured, capFreeAt: new Date(NOW.getTime() + 2 * DAY), now: NOW, blockingPolicy: "cap" });
    expect(soon.refreshRequiredBeforeSend).toBe(false);
  });

  it("a qualified prospect becomes dispatchable once the cap clears", () => {
    const plan = dispatchPlan({ benchmarkCapturedAt: new Date(NOW.getTime() - DAY), capFreeAt: new Date(NOW.getTime() - 1), now: NOW, blockingPolicy: "cap" });
    expect(plan.status).toBe("DISPATCHABLE_NOW");
    expect(plan.blockingPolicy).toBeNull();
    expect(plan.refreshRequiredBeforeSend).toBe(false);
  });
});

describe("stages and metrics", () => {
  it("names the full pipeline from universe to sent", () => {
    expect(SUPPLY_STAGES[0]).toBe("REAL_TRENDS_UNIVERSE");
    expect(SUPPLY_STAGES).toContain("DEFERRED_BY_DISPATCH_POLICY");
    expect(SUPPLY_STAGES[SUPPLY_STAGES.length - 1]).toBe("SENT");
  });

  it("derived metrics are ratios over the funnel, null when undefined", () => {
    const m = supplyMetrics({ sourceUniverse: 100, entityNormalized: 50, marketAllowed: 40, prequalified: 20, contactVerified: 10, benchmarked: 10, mismatch: 4, evidenceVerified: 3, qualified: 3, dispatchableNow: 1, deferredQualified: 2 }, 2);
    expect(m).toMatchObject({ contactVerificationRate: 0.5, evidenceVerificationRate: 0.75, qualifiedPerContactVerified: 0.3, qualifiedPerBenchmarkedMarket: 1.5 });
    expect(supplyMetrics({ sourceUniverse: 0, entityNormalized: 0, marketAllowed: 0, prequalified: 0, contactVerified: 0, benchmarked: 0, mismatch: 0, evidenceVerified: 0, qualified: 0, dispatchableNow: 0, deferredQualified: 0 }, 0).qualifiedPerBenchmarkedMarket).toBeNull();
  });
});

describe("market expansion classes (founder approval queue)", () => {
  const base = { policyState: "UNCLASSIFIED" as const, teams: 150, individuals: 300, highProduction: 40, teams100m: 5, brokerageDiversity: 12, namedLeads: 30 };
  it("top-slice economic value is a PREMIUM reserve candidate, never auto-opened", () => {
    const r = marketExpansionClass({ ...base, teams100m: PREMIUM_RESERVE_TEAMS_100M + 10 });
    expect(r.klass).toBe("PREMIUM_RESERVE_CANDIDATE");
    expect(r.reasons.some((x) => /exclusivity/.test(x))).toBe(true);
  });
  it("depth plus brokerage diversity is a proof-building candidate; thin markets are research-more or low", () => {
    expect(marketExpansionClass(base).klass).toBe("PROOF_BUILDING_CANDIDATE");
    expect(marketExpansionClass({ ...base, brokerageDiversity: 4 }).klass).toBe("RESEARCH_MORE");
    expect(marketExpansionClass({ ...base, highProduction: 3 }).klass).toBe("LOW_PRIORITY");
  });
  it("reserved and already-open markets are not expansion candidates", () => {
    expect(marketExpansionClass({ ...base, policyState: "TIER_1_RESERVED" }).klass).toBe("PREMIUM_RESERVE_CANDIDATE");
    expect(marketExpansionClass({ ...base, policyState: "PROOF_BUILDING" }).klass).toBe("LOW_PRIORITY");
  });
});
