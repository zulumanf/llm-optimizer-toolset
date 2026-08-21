/**
 * Spec 098 — intent, attribution, follow-up, and cohort math are pure and
 * known-answer tested. Every fixture is a measured-fact record; nothing here
 * touches a database.
 */
import { describe, expect, it } from "vitest";
import {
  DIAGNOSTIC_MIN_CONTACTED,
  INTENT_WEIGHTS,
  compareByPriority,
  deriveIntent,
  diagnose,
  summarizeCohort,
  type AuditViewFact,
  type ProspectBehaviorFacts,
} from "@/lib/prospects/intent";

const NOW = new Date("2026-08-21T12:00:00Z");
const SENT = new Date("2026-08-20T08:21:00Z");
const h = (hours: number): Date => new Date(SENT.getTime() + hours * 3_600_000);

const view = (over: Partial<AuditViewFact> = {}): AuditViewFact => ({
  viewedAt: h(0.15), // 8:30 — 9 minutes after the send
  sessionId: "s1",
  visitorId: "v1",
  linkKey: "k1",
  engagedSeconds: 0,
  maxScrollPercent: 0,
  sectionsViewed: [],
  evidenceExpanded: false,
  ctaClicked: false,
  ...over,
});

const facts = (over: Partial<ProspectBehaviorFacts> = {}): ProspectBehaviorFacts => ({
  prospectId: "p",
  businessName: "Team X",
  launchId: "l",
  launchName: "Jersey City",
  qualityScore: 80,
  stage: "contacted",
  visitedStages: ["contacted"],
  sentAts: [SENT],
  opens: 0,
  views: [],
  hasEmail: true,
  auditPublished: true,
  ...over,
});

describe("intent score — known answers", () => {
  it("no behavior: Cold, 0, wait", () => {
    const p = deriveIntent(facts(), NOW);
    expect(p.intentScore).toBe(0);
    expect(p.intentLabel).toBe("Cold");
    expect(p.engagement.attribution).toBe("none");
    expect(p.priorityTier).toBe(8);
  });

  it("one shallow view: +2 Aware, follow-up leads with the finding", () => {
    const p = deriveIntent(facts({ views: [view()] }), NOW);
    expect(p.intentScore).toBe(INTENT_WEIGHTS.qualifyingView);
    expect(p.intentLabel).toBe("Aware");
    expect(p.engagement.meaningfullyEngaged).toBe(false);
    expect(p.recommendedAction).toMatch(/strongest specific audit finding/);
    expect(p.engagement.secondsToFirstView).toBe(9 * 60);
  });

  it("engaged-time thresholds do not double count (60s is +2 total, not +3)", () => {
    const thirty = deriveIntent(facts({ views: [view({ engagedSeconds: 30 })] }), NOW);
    const sixty = deriveIntent(facts({ views: [view({ engagedSeconds: 60 })] }), NOW);
    expect(thirty.intentScore).toBe(2 + 1);
    expect(sixty.intentScore).toBe(2 + 2);
    expect(thirty.engagement.meaningfullyEngaged).toBe(true);
  });

  it("deep visit: view + 60s + 75% + competitor + evidence = 8, High intent", () => {
    const p = deriveIntent(
      facts({ views: [view({ engagedSeconds: 90, maxScrollPercent: 92, sectionsViewed: ["competitors"], evidenceExpanded: true })] }),
      NOW
    );
    expect(p.intentScore).toBe(2 + 2 + 2 + 1 + 1);
    expect(p.intentLabel).toBe("High intent");
    expect(p.priorityTier).toBe(3); // high authority + high intent
    expect(p.recommendedAction).toMatch(/personalized follow-up/);
  });

  it("repeat sessions: +3, three sessions +2 more; the engaged time of one session is not the max of another", () => {
    const p = deriveIntent(
      facts({
        views: [
          view({ sessionId: "s1", engagedSeconds: 20 }),
          view({ sessionId: "s2", viewedAt: h(6), engagedSeconds: 20 }),
          view({ sessionId: "s3", viewedAt: h(26), engagedSeconds: 25 }),
        ],
      }),
      NOW
    );
    expect(p.engagement.sessions).toBe(3);
    expect(p.engagement.engagedSeconds).toBe(65);
    expect(p.engagement.repeat).toBe(true);
    // 2 view + 2 (≥60s summed) + 3 repeat + 2 many
    expect(p.intentScore).toBe(9);
    expect(p.recommendedAction).toBe("High-priority personalized follow-up.");
  });

  it("a second browser identity is a possible additional visitor, never a claim", () => {
    const p = deriveIntent(
      facts({ views: [view({ sessionId: "s1", visitorId: "v1" }), view({ sessionId: "s2", visitorId: "v2", viewedAt: h(3) })] }),
      NOW
    );
    expect(p.engagement.visitorIdentities).toBe(2);
    expect(p.engagement.possibleAdditionalVisitor).toBe(true);
    expect(p.intentScore).toBe(2 + 3 + INTENT_WEIGHTS.possibleSecondVisitor);
  });

  it("views without a session id each count as their own session; missing identities are reported", () => {
    const p = deriveIntent(
      facts({ views: [view({ sessionId: null, visitorId: null }), view({ sessionId: null, visitorId: null, viewedAt: h(2) })] }),
      NOW
    );
    expect(p.engagement.sessions).toBe(2);
    expect(p.engagement.visitorIdentities).toBe(0);
    expect(p.engagement.unknownIdentityViews).toBe(2);
  });

  it("CTA click: +3 and tier 2, reach out promptly", () => {
    const p = deriveIntent(facts({ views: [view({ ctaClicked: true })] }), NOW);
    expect(p.intentScore).toBe(2 + 3);
    expect(p.priorityTier).toBe(2);
    expect(p.recommendedAction).toMatch(/promptly/);
  });

  it("reply and meeting are Opportunity regardless of page behavior; audit_viewed stage is not a reply", () => {
    const replied = deriveIntent(facts({ stage: "replied", visitedStages: ["contacted", "replied"] }), NOW);
    expect(replied.sales.replied).toBe(true);
    expect(replied.intentLabel).toBe("Opportunity");
    expect(replied.intentScore).toBe(INTENT_WEIGHTS.reply);
    expect(replied.priorityTier).toBe(1);
    const meeting = deriveIntent(facts({ stage: "discovery_scheduled", visitedStages: ["contacted", "replied", "discovery_scheduled"] }), NOW);
    expect(meeting.intentScore).toBe(INTENT_WEIGHTS.reply + INTENT_WEIGHTS.meeting);
    expect(meeting.recommendedAction).toMatch(/meeting brief/);
    const viewedStage = deriveIntent(facts({ stage: "audit_viewed", visitedStages: ["contacted", "audit_sent", "audit_viewed"] }), NOW);
    expect(viewedStage.sales.replied).toBe(false);
  });
});

describe("attribution — pre vs post outreach, link vs unattributed", () => {
  it("views before the first send never count toward the funnel", () => {
    const p = deriveIntent(facts({ views: [view({ viewedAt: h(-5) })] }), NOW);
    expect(p.engagement.preOutreachViews).toBe(1);
    expect(p.engagement.postOutreachViews).toBe(0);
    expect(p.engagement.attribution).toBe("pre_outreach_only");
    expect(p.intentScore).toBe(0);
  });

  it("a bare-token view after the send is unattributed external activity", () => {
    const p = deriveIntent(facts({ views: [view({ linkKey: null })] }), NOW);
    expect(p.engagement.attribution).toBe("unattributed_external");
  });

  it("a branded-link view is attributed to the emailed link", () => {
    const p = deriveIntent(facts({ views: [view({ linkKey: "k1" })] }), NOW);
    expect(p.engagement.attribution).toBe("attributed_link");
  });

  it("an uncontacted prospect with views is real activity outside the ledger — ranked, never attributed, never funnel evidence", () => {
    const p = deriveIntent(facts({ sentAts: [], views: [view(), view({ sessionId: "s2", viewedAt: h(4) })] }), NOW);
    expect(p.sales.contacted).toBe(false);
    expect(p.engagement.outsideLedger).toBe(true);
    expect(p.engagement.sessions).toBe(2);
    expect(p.engagement.attribution).toBe("unattributed_external");
    expect(p.priorityTier).toBe(4);
    expect(p.recommendedAction).toMatch(/no recorded send/);
    const c = summarizeCohort([p], NOW);
    expect(c.contacted).toBe(0);
    expect(c.viewed).toBe(0);
    expect(c.prospectsWithAnyView).toBe(1);
  });
});

describe("contacted state and follow-up cadence derive from the ledger", () => {
  it("contacted is true from an allowed send even when the stage column lags", () => {
    const p = deriveIntent(facts({ stage: "identified", visitedStages: [] }), NOW);
    expect(p.sales.contacted).toBe(true);
    expect(p.sales.touches).toBe(1);
  });

  it("silent cadence: due after 3 days, not before; capped at max touches", () => {
    const fresh = deriveIntent(facts({ sentAts: [new Date(NOW.getTime() - 2 * 86_400_000)] }), NOW);
    expect(fresh.followUpDue).toBe(false);
    expect(fresh.priorityTier).toBe(8);
    const stale = deriveIntent(facts({ sentAts: [new Date(NOW.getTime() - 4 * 86_400_000)] }), NOW);
    expect(stale.followUpDue).toBe(true);
    expect(stale.priorityTier).toBe(7);
    expect(stale.recommendedAction).toMatch(/new reason/);
    const maxed = deriveIntent(
      facts({ sentAts: [new Date(NOW.getTime() - 20 * 86_400_000), new Date(NOW.getTime() - 12 * 86_400_000), new Date(NOW.getTime() - 5 * 86_400_000)] }),
      NOW
    );
    expect(maxed.followUpDue).toBe(false);
    expect(maxed.recommendedAction).toMatch(/Max touches/);
  });

  it("engaged cadence: a view after the last send waits one day, then is due", () => {
    const sent = new Date(NOW.getTime() - 5 * 86_400_000);
    const viewedRecently = deriveIntent(
      facts({ sentAts: [sent], views: [view({ viewedAt: new Date(NOW.getTime() - 3_600_000) })] }),
      NOW
    );
    expect(viewedRecently.followUpDue).toBe(false);
    const viewedYesterday = deriveIntent(
      facts({ sentAts: [sent], views: [view({ viewedAt: new Date(NOW.getTime() - 30 * 3_600_000) })] }),
      NOW
    );
    expect(viewedYesterday.followUpDue).toBe(true);
  });

  it("replied prospects are never follow-up due", () => {
    const p = deriveIntent(
      facts({ stage: "replied", visitedStages: ["replied"], sentAts: [new Date(NOW.getTime() - 10 * 86_400_000)] }),
      NOW
    );
    expect(p.followUpDue).toBe(false);
  });
});

describe("priority order and cohort funnel", () => {
  it("ranks conversation > CTA > high authority+intent > repeat > deep > single > due > silent > uncontacted", () => {
    const items = [
      deriveIntent(facts({ prospectId: "uncontacted", sentAts: [] }), NOW),
      deriveIntent(facts({ prospectId: "silent" }), NOW),
      deriveIntent(facts({ prospectId: "due", sentAts: [new Date(NOW.getTime() - 4 * 86_400_000)] }), NOW),
      deriveIntent(facts({ prospectId: "single", views: [view()] }), NOW),
      deriveIntent(facts({ prospectId: "deep", qualityScore: 20, views: [view({ engagedSeconds: 45 })] }), NOW),
      deriveIntent(facts({ prospectId: "repeat", qualityScore: 20, views: [view(), view({ sessionId: "s2", viewedAt: h(5) })] }), NOW),
      deriveIntent(facts({ prospectId: "hq-hi", views: [view({ engagedSeconds: 90, maxScrollPercent: 90 })] }), NOW),
      deriveIntent(facts({ prospectId: "cta", views: [view({ ctaClicked: true })] }), NOW),
      deriveIntent(facts({ prospectId: "replied", stage: "replied", visitedStages: ["replied"] }), NOW),
    ];
    const order = [...items].sort(compareByPriority).map((p) => p.prospectId);
    expect(order).toEqual(["replied", "cta", "hq-hi", "repeat", "deep", "single", "due", "silent", "uncontacted"]);
  });

  it("funnel denominators: viewers / contacted, engaged / viewers; uncontacted views never count", () => {
    const items = [
      deriveIntent(facts({ prospectId: "a", views: [view({ engagedSeconds: 40 })] }), NOW),
      deriveIntent(facts({ prospectId: "b", views: [view()] }), NOW),
      deriveIntent(facts({ prospectId: "c" }), NOW),
      deriveIntent(facts({ prospectId: "d", sentAts: [], views: [view()] }), NOW),
    ];
    const c = summarizeCohort(items, NOW);
    expect(c.contacted).toBe(3);
    expect(c.viewed).toBe(2);
    expect(c.engaged).toBe(1);
    expect(c.prospectsWithAnyView).toBe(3); // includes the uncontacted "d"
    const viewed = c.funnel.find((f) => f.key === "viewed")!;
    expect(viewed.of).toBe(3);
    expect(viewed.rate).toBeCloseTo(2 / 3);
    const engaged = c.funnel.find((f) => f.key === "engaged")!;
    expect(engaged.of).toBe(2);
    expect(engaged.rate).toBe(0.5);
    expect(c.funnel.find((f) => f.key === "replied")!.rate).toBe(0);
    expect(c.medianSecondsToFirstView).toBe(9 * 60);
    expect(c.diagnosis.verdict).toBe("not_enough_data");
  });

  it("an empty cohort yields null rates, never zero", () => {
    const c = summarizeCohort([], NOW);
    expect(c.funnel.find((f) => f.key === "viewed")!.rate).toBeNull();
    expect(c.cohortAgeDays).toBeNull();
  });

  it("diagnostics stay silent on small or young cohorts, then say 'possible bottleneck'", () => {
    const base = { viewed: 0, engaged: 0, replied: 0, meeting: 0, proposal: 0, client: 0, followUpDue: 0, notContacted: 0, auditViews: 0, auditSessions: 0, auditVisitorIdentities: 0, prospectsWithAnyView: 0, preOutreachViews: 0, attributedLinkProspects: 0, unattributedProspects: 0, opens: 0, openedProspects: 0, medianSecondsToFirstView: null, funnel: [] };
    expect(diagnose({ ...base, contacted: DIAGNOSTIC_MIN_CONTACTED, cohortAgeDays: 0.5 }).verdict).toBe("not_enough_data");
    expect(diagnose({ ...base, contacted: 5, cohortAgeDays: 10 }).verdict).toBe("not_enough_data");
    const outreach = diagnose({ ...base, contacted: 20, viewed: 1, cohortAgeDays: 5 });
    expect(outreach.verdict).toBe("possible_bottleneck");
    expect(outreach.bottleneck).toBe("outreach");
    const audit = diagnose({ ...base, contacted: 20, viewed: 10, engaged: 2, cohortAgeDays: 5 });
    expect(audit.bottleneck).toBe("audit_experience");
    const commercial = diagnose({ ...base, contacted: 20, viewed: 10, engaged: 8, replied: 0, cohortAgeDays: 5 });
    expect(commercial.bottleneck).toBe("commercial_conversion");
  });
});
