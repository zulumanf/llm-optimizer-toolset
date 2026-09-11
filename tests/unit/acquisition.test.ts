/**
 * Acquisition control panel — the truth rules the Analyze tab is built on:
 * prospect-unique Touch 1, delivered denominators, touches never
 * double-counted, corrections and founder replies outside the campaign
 * counts, eras separated, pauses split, zero-inventory runway, a
 * deterministic bottleneck, uninstrumented stages flagged, and a
 * sequence-less positive reply that still surfaces as an opportunity.
 */
import { describe, expect, it } from "vitest";
import {
  acquisitionStatus,
  canonicalReplies,
  deriveAcquisition,
  inventoryRunway,
  touchBefore,
  uniqueTouch1,
  type AcquisitionFacts,
  type MarketSupplyFact,
  type ReplyFact,
  type SequenceFact,
  type T1Fact,
} from "@/lib/prospects/acquisition";
import { ACQUISITION_SAMPLE, GMAIL_DAILY_SEND_CAP, SEND_CAP_HEADROOM } from "@/lib/prospects/constants";

const NOW = new Date("2026-09-06T16:00:00Z");
const day = (iso: string) => new Date(iso);

function t1(over: Partial<T1Fact> & { prospectId: string }): T1Fact {
  return {
    sendId: `send-${over.prospectId}`,
    businessName: over.prospectId,
    market: "Raleigh — luxury residential",
    launchId: "l1",
    prospectType: "team",
    sentAt: day("2026-09-01T13:00:00Z"),
    bounced: false,
    runId: "run1",
    competitorCompanyId: "comp1",
    competitorName: "Rival",
    recsProspect: 1,
    recsCompetitor: 12,
    competitorProductionRatio: 0.5,
    correctedProspect: null,
    correctedCompetitor: null,
    anyOpens: 0,
    credibleOpens: 0,
    ...over,
  };
}
function reply(prospectId: string, classification: string, receivedAt: string, createdAt = receivedAt, pricingRequested = false): ReplyFact {
  return { prospectId, classification, receivedAt: day(receivedAt), createdAt: day(createdAt), pricingRequested };
}
function seq(prospectId: string, over: Partial<SequenceFact> = {}): SequenceFact {
  return { id: `seq-${prospectId}`, prospectId, status: "active", nextTouch: 2, nextDueAt: day("2026-09-09T13:00:00Z"), pausedUntil: null, pauseReason: null, stopReason: null, ...over };
}
function supply(over: Partial<MarketSupplyFact> = {}): MarketSupplyFact {
  return { launchId: "l1", market: "Raleigh — luxury residential", sourced: 100, rtMatched: 80, contactable: 40, drafted: 30, scheduled: 0, ready: 0, awaitingApproval: 0, parked: 0, ...over };
}
function facts(over: Partial<AcquisitionFacts> = {}): AcquisitionFacts {
  return {
    t1: [],
    replies: [],
    sequences: [],
    touchSends: [],
    reports: [],
    supply: [supply()],
    queued: [],
    era1: { prospects: 80, sends: 100, repliedStage: 0, positive: 0, bounced: 3, auditViewed: 13, firstSentAt: day("2026-08-20T00:00:00Z"), lastSentAt: day("2026-09-01T00:00:00Z") },
    opportunities: [],
    competitorRanks: [{ runId: "run1", companyId: "comp1", rank: 2 }],
    clientsWon: 0,
    benchmarkSpendUsd: 36,
    refusals: [],
    capDeferrals: 0,
    gmailHealthy: true,
    capLimit: GMAIL_DAILY_SEND_CAP,
    ...over,
  };
}

describe("touch 1 identity and denominators", () => {
  it("counts a prospect once even when two Touch 1 sends exist (the report reply chained to the snapshot)", () => {
    const f = facts({ t1: [t1({ prospectId: "ryan" }), t1({ prospectId: "ryan", sendId: "send-ryan-2", sentAt: day("2026-09-05T18:00:00Z") })] });
    expect(uniqueTouch1(f.t1)).toHaveLength(1);
    const p = deriveAcquisition(f, NOW);
    expect(p.hero.uniqueT1).toBe(1);
    expect(p.hero.sends.t1).toBe(2);
  });
  it("uses unique DELIVERED Touch 1 recipients as the positive-reply denominator", () => {
    const f = facts({
      t1: [t1({ prospectId: "a" }), t1({ prospectId: "b", bounced: true }), t1({ prospectId: "c" })],
      replies: [reply("a", "positive_interest", "2026-09-03T19:53:24Z")],
    });
    const p = deriveAcquisition(f, NOW);
    expect(p.hero.uniqueT1).toBe(3);
    expect(p.hero.deliveredT1).toBe(2);
    expect(p.hero.positiveReplies).toEqual({ n: 1, of: 2, rate: 0.5 });
    expect(p.eras[1]!.bounceRate).toEqual({ n: 1, of: 3, rate: 1 / 3 });
  });
  it("never counts T2/T3 as Touch 1 and never double-counts a touch", () => {
    const f = facts({
      t1: [t1({ prospectId: "a" })],
      sequences: [seq("a")],
      touchSends: [
        { prospectId: "a", kind: "T2", sentAt: day("2026-09-04T13:00:00Z"), offerPresented: false },
        { prospectId: "a", kind: "T3", sentAt: day("2026-09-08T13:00:00Z"), offerPresented: false },
      ],
    });
    const p = deriveAcquisition(f, NOW);
    expect(p.hero.uniqueT1).toBe(1);
    expect(p.hero.sends).toMatchObject({ t1: 1, t2: 1, t3: 1 });
    expect(p.touchPerf.map((t) => t.sent)).toEqual([1, 1, 1]);
  });
  it("keeps evidence corrections and founder replies out of T1/T2/T3 and tracks them apart", () => {
    const f = facts({
      t1: [t1({ prospectId: "a", correctedProspect: 4, correctedCompetitor: 12 })],
      touchSends: [
        { prospectId: "a", kind: "CORRECTION", sentAt: day("2026-09-08T13:00:00Z"), offerPresented: false },
        { prospectId: "a", kind: "FOUNDER", sentAt: day("2026-09-08T14:00:00Z"), offerPresented: false },
      ],
      replies: [reply("a", "question", "2026-09-08T15:00:00Z")],
    });
    const p = deriveAcquisition(f, NOW);
    expect(p.hero.sends).toMatchObject({ t1: 1, t2: 0, t3: 0, corrections: 1, founder: 1 });
    expect(p.evidence.correctionsSent).toBe(1);
    expect(p.evidence.correctionReplies).toBe(1);
    // The reply landed after the correction, so it is not "after T1".
    expect(p.touchPerf[0]!.repliesAfter).toBe(0);
  });
});

describe("replies", () => {
  it("takes the latest classification recorded for a message (the mis-recorded unsubscribe loses)", () => {
    const rows = [
      reply("steve", "unclear", "2026-09-03T19:53:24Z", "2026-09-03T20:00:00Z"),
      reply("steve", "unsubscribe", "2026-09-03T19:53:24Z", "2026-09-03T21:00:00Z"),
      reply("steve", "positive_interest", "2026-09-03T19:53:24Z", "2026-09-03T22:00:00Z"),
    ];
    expect(canonicalReplies(rows).map((r) => r.classification)).toEqual(["positive_interest"]);
  });
  it("attributes a reply to the last touch before it, never as cause", () => {
    const first = t1({ prospectId: "a" });
    const touches = [{ prospectId: "a", kind: "T2" as const, sentAt: day("2026-09-04T13:00:00Z"), offerPresented: false }];
    expect(touchBefore("a", day("2026-09-03T00:00:00Z"), first, touches)).toBe("T1");
    expect(touchBefore("a", day("2026-09-05T00:00:00Z"), first, touches)).toBe("T2");
  });
  it("does not treat an auto-responder as a human reply", () => {
    const f = facts({ t1: [t1({ prospectId: "a" })], replies: [reply("a", "out_of_office", "2026-09-02T00:00:00Z")] });
    expect(deriveAcquisition(f, NOW).funnel.find((r) => r.key === "reply")!.count).toBe(0);
  });
});

describe("eras", () => {
  it("keeps Era 1 and Era 2 separate — Era 1 facts never enter the current experiment", () => {
    const f = facts({ t1: [t1({ prospectId: "a" })], replies: [reply("a", "positive_interest", "2026-09-03T00:00:00Z")] });
    const p = deriveAcquisition(f, NOW);
    expect(p.eras[0]).toMatchObject({ era: "Era 1", uniqueProspects: 80, positive: 0 });
    expect(p.eras[1]).toMatchObject({ era: "Era 2", uniqueProspects: 1, positive: 1 });
    expect(p.hero.uniqueT1).toBe(1);
  });
});

describe("follow-up pipeline", () => {
  it("splits paused sequences into evidence review vs out-of-office and counts due/overdue by business days", () => {
    const f = facts({
      t1: [t1({ prospectId: "a" }), t1({ prospectId: "b" }), t1({ prospectId: "c" }), t1({ prospectId: "d" })],
      sequences: [
        seq("a", { status: "paused", pauseReason: "operator: MATERIAL_SENT_CLAIM_ERROR: Spec 130 evidence correction" }),
        seq("b", { status: "paused", pauseReason: "out of office — no return date parsed", pausedUntil: day("2026-09-12T00:00:00Z") }),
        // Friday 9/4 slot deferred over Labor Day weekend: due, not overdue on Sunday 9/6.
        seq("c", { status: "active", nextDueAt: day("2026-09-04T13:00:00Z") }),
        seq("d", { status: "stopped", stopReason: "operator: NO_LONGER_ELIGIBLE" }),
      ],
    });
    const p = deriveAcquisition(f, NOW);
    expect(p.followups).toMatchObject({ active: 1, t2Due: 1, overdue: 0, pausedEvidenceReview: 1, oooPaused: 1, stopped: 1 });
    expect(p.evidence.pausedCorrectionSequences).toBe(1);
  });
  it("labels touch performance INSUFFICIENT SAMPLE under the floor instead of a percentage", () => {
    const f = facts({ t1: [t1({ prospectId: "a" })], touchSends: [{ prospectId: "a", kind: "T2", sentAt: day("2026-09-04T13:00:00Z"), offerPresented: false }] });
    expect(deriveAcquisition(f, NOW).touchPerf[1]!.sample).toBe("INSUFFICIENT SAMPLE");
  });
});

describe("inventory and runway", () => {
  it("returns zero runway for zero inventory without dividing by zero", () => {
    expect(inventoryRunway(0, 0, GMAIL_DAILY_SEND_CAP)).toEqual({ dailyT1Capacity: GMAIL_DAILY_SEND_CAP - SEND_CAP_HEADROOM, runwayDays: 0 });
    const p = deriveAcquisition(facts({ supply: [supply({ ready: 0, scheduled: 0 })] }), NOW);
    expect(p.hero.runwayDays).toBe(0);
    expect(p.hero.inventory).toEqual({ ready: 0, scheduled: 0, notReady: 10 });
  });
  it("subtracts the follow-up load from the cap before estimating sending days", () => {
    // 30 ready, 33 follow-ups over 5 days → ceil(6.6)=7/day load → 25-1-7 = 17/day → 2 days.
    expect(inventoryRunway(30, 33, 25)).toEqual({ dailyT1Capacity: 17, runwayDays: 2 });
  });
});

describe("status and bottleneck", () => {
  it("derives the status label deterministically from delivered, positive and clients", () => {
    expect(acquisitionStatus(10, 1, 0).status).toBe("INSUFFICIENT DATA");
    expect(acquisitionStatus(68, 2, 0).status).toBe("PROMISING");
    expect(acquisitionStatus(68, 1, 0).status).toBe("WATCH");
    expect(acquisitionStatus(68, 0, 0).status).toBe("WEAK");
    expect(acquisitionStatus(68, 2, 1).status).toBe("HEALTHY");
    expect(acquisitionStatus(200, 5, 0).status).toBe("HEALTHY");
  });
  it("calls the bottleneck the same way twice and names contact verification when that is the biggest supply drop", () => {
    const f = facts({ t1: [t1({ prospectId: "a" })], supply: [supply({ sourced: 379, rtMatched: 316, contactable: 152, drafted: 99, ready: 4, scheduled: 26 })] });
    const one = deriveAcquisition(f, NOW).bottleneck;
    const two = deriveAcquisition(f, NOW).bottleneck;
    expect(one).toEqual(two);
    expect(one.primary?.name).toBe("CONTACT VERIFICATION");
  });
  it("puts data integrity first when a no-longer-eligible sequence is still active", () => {
    const f = facts({
      t1: [t1({ prospectId: "a", recsProspect: 0, recsCompetitor: 5, correctedProspect: 9, correctedCompetitor: 5 })],
      sequences: [seq("a")],
      supply: [supply({ ready: 50, scheduled: 50 })],
    });
    const p = deriveAcquisition(f, NOW);
    expect(p.evidence).toMatchObject({ noLongerEligible: 1, activeNoLongerEligible: 1, alert: "ATTENTION REQUIRED" });
    expect(p.bottleneck.primary?.name).toBe("DATA INTEGRITY");
  });
  it("reads CLEAR once corrected claims are answered or their sequences closed", () => {
    const f = facts({
      t1: [t1({ prospectId: "a", correctedProspect: 4, correctedCompetitor: 12 })],
      sequences: [seq("a", { status: "stopped", stopReason: "operator: Spec 130 evidence correction" })],
      touchSends: [{ prospectId: "a", kind: "CORRECTION", sentAt: day("2026-09-08T13:00:00Z"), offerPresented: false }],
    });
    expect(deriveAcquisition(f, NOW).evidence).toMatchObject({ material: 1, unresolved: 0, alert: "CLEAR" });
  });
});

describe("clients, reports and opportunities", () => {
  it("counts clients only from the canonical engagement count, never from a prospect stage", () => {
    const f = facts({
      t1: [t1({ prospectId: "fixture" })],
      opportunities: [{ prospectId: "fixture", businessName: "QA131 Fixture Team", market: "QA131 Sandbox", stage: "contracted", nextAction: null, nextActionOn: null, lastActivityKind: null, lastActivityAt: null, lastSendAt: null }],
      clientsWon: 0,
    });
    const p = deriveAcquisition(f, NOW);
    expect(p.hero.clientsWon).toBe(0);
    expect(p.funnel.find((r) => r.key === "client")!.count).toBe(0);
    expect(p.economics.cac).toBeNull();
    expect(p.economics.scenario?.label).toContain("SCENARIO".length ? "engagement" : "");
  });
  it("flags the offer stage as not fully instrumented and the report stage as an insufficient sample", () => {
    const p = deriveAcquisition(facts({ t1: [t1({ prospectId: "a" })] }), NOW);
    expect(p.funnel.find((r) => r.key === "offer")!.instrumented).toBe(false);
    expect(p.funnel.filter((r) => !r.instrumented).map((r) => r.key)).toEqual(["offer"]);
    expect(p.report.sample).toBe("INSUFFICIENT SAMPLE");
  });
  it("keeps a positive reply with no sequence row in the opportunity view, ranked high intent when pricing was asked", () => {
    const f = facts({
      t1: [t1({ prospectId: "ryan", correctedProspect: 29, correctedCompetitor: 38 }), t1({ prospectId: "steve" })],
      replies: [reply("ryan", "positive_interest", "2026-09-05T14:54:57Z", "2026-09-05T15:00:00Z", true), reply("steve", "positive_interest", "2026-09-03T19:53:24Z")],
      touchSends: [{ prospectId: "ryan", kind: "FOUNDER", sentAt: day("2026-09-05T18:00:51Z"), offerPresented: true }],
      sequences: [seq("steve", { status: "replied" })],
      opportunities: [
        { prospectId: "steve", businessName: "Steve Wall", market: "Raleigh", stage: "replied", nextAction: null, nextActionOn: null, lastActivityKind: "draft_sent", lastActivityAt: day("2026-09-04T12:02:00Z"), lastSendAt: day("2026-09-04T12:02:00Z") },
        { prospectId: "ryan", businessName: "Blu House Properties", market: "Grand Rapids", stage: "audit_sent", nextAction: "Await the reply", nextActionOn: "2026-09-08", lastActivityKind: "stage_changed", lastActivityAt: day("2026-09-05T18:00:53Z"), lastSendAt: day("2026-09-05T18:00:51Z") },
      ],
    });
    const p = deriveAcquisition(f, NOW);
    expect(p.opportunities.map((o) => [o.businessName, o.replyType])).toEqual([
      ["Blu House Properties", "HIGH_INTENT"],
      ["Steve Wall", "POSITIVE_CURIOSITY"],
    ]);
    expect(p.opportunities[0]!.offerStatus).toContain("Offer presented");
    expect(p.hero.liveLeads).toEqual({ positive: 2, highIntent: 1 });
    expect(p.funnel.find((r) => r.key === "pricing")!.count).toBe(1);
    expect(p.funnel.find((r) => r.key === "reportDelivered")!.count).toBe(1);
    expect(p.icp.hypothesis.status).toBe("POSSIBLE");
    expect(p.priorities[0]!.text).toContain("Blu House Properties: high-intent lead");
    expect(p.priorities.length).toBeLessThanOrEqual(5);
  });
  it("labels ICP cuts under the floor SMALL SAMPLE and never promotes the hypothesis from n<5", () => {
    const p = deriveAcquisition(facts({ t1: [t1({ prospectId: "a" })], replies: [reply("a", "positive_interest", "2026-09-03T00:00:00Z")] }), NOW);
    expect(p.icp.recommendations.every((c) => c.sample === "SMALL SAMPLE")).toBe(true);
    expect(p.icp.hypothesis.status).toBe("POSSIBLE");
    expect(ACQUISITION_SAMPLE.positiveForSupport).toBeGreaterThan(2);
  });
});
