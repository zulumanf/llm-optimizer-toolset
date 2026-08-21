/**
 * Spec 098 — intent, attribution, follow-up, and cohort math are pure and
 * known-answer tested. Every fixture is a measured-fact record; nothing here
 * touches a database.
 */
import { describe, expect, it } from "vitest";
import {
  DIAGNOSTIC_MIN_CONTACTED,
  FOLLOW_UP_RULES,
  INTENT_WEIGHTS,
  businessDaysBetween,
  compareByPriority,
  startOfOperatorDay,
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
  sends: [],
  prospectType: null,
  repliedAt: null,
  meetingAt: null,
  opens: 0,
  views: [],
  hasEmail: true,
  auditPublished: true, unqualifiedViews: 0,
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

  it("spec 099: session count alone never reaches High intent — four shallow sessions cap at Interested", () => {
    const p = deriveIntent(
      facts({
        views: [1, 2, 3, 4].map((i) => view({ sessionId: `s${i}`, visitorId: null, viewedAt: h(i), engagedSeconds: 5 })),
      }),
      NOW
    );
    expect(p.engagement.sessions).toBe(4);
    expect(p.engagement.meaningfullyEngaged).toBe(false);
    // 2 view + 1 multiple sessions + 1 many sessions
    expect(p.intentScore).toBe(2 + INTENT_WEIGHTS.repeatSession + INTENT_WEIGHTS.manySessions);
    expect(p.intentLabel).toBe("Interested");
    expect(p.priorityTier).toBe(5);
    expect(p.recommendedAction).toMatch(/Multiple short sessions/);
  });

  it("spec 099: even a high raw score is capped at Interested without meaningful engagement or a CTA", () => {
    // Two browser identities + many sessions + scroll just under the bar: 2+1+1+1 = 5 anyway,
    // so force the cap path with evidence expanded and no dwell (+1 → 6).
    const p = deriveIntent(
      facts({
        views: [
          view({ sessionId: "s1", visitorId: "v1", evidenceExpanded: true, engagedSeconds: 3 }),
          view({ sessionId: "s2", visitorId: "v2", viewedAt: h(2), engagedSeconds: 3 }),
          view({ sessionId: "s3", visitorId: "v2", viewedAt: h(4), engagedSeconds: 3 }),
        ],
      }),
      NOW
    );
    expect(p.intentScore).toBeGreaterThanOrEqual(6);
    expect(p.engagement.meaningfullyEngaged).toBe(false);
    expect(p.intentLabel).toBe("Interested");
  });

  it("spec 099: an interaction only counts as meaningful with ≥10s dwell", () => {
    const noDwell = deriveIntent(facts({ views: [view({ evidenceExpanded: true, engagedSeconds: 4 })] }), NOW);
    expect(noDwell.engagement.meaningfullyEngaged).toBe(false);
    const dwell = deriveIntent(facts({ views: [view({ sectionsViewed: ["competitors"], engagedSeconds: 12 })] }), NOW);
    expect(dwell.engagement.meaningfullyEngaged).toBe(true);
    const cta = deriveIntent(facts({ views: [view({ ctaClicked: true })] }), NOW);
    expect(cta.engagement.meaningfullyEngaged).toBe(true);
  });

  it("multiple sessions: +1, three sessions +1 more; the engaged time of one session is not the max of another", () => {
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
    // 2 view + 2 (≥60s summed) + 1 multiple + 1 many
    expect(p.intentScore).toBe(6);
    expect(p.intentLabel).toBe("High intent"); // 65s engaged is a verified strong signal
    expect(p.recommendedAction).toMatch(/High-priority personalized follow-up/);
  });

  it("a second browser identity is a possible additional visitor, never a claim", () => {
    const p = deriveIntent(
      facts({ views: [view({ sessionId: "s1", visitorId: "v1" }), view({ sessionId: "s2", visitorId: "v2", viewedAt: h(3) })] }),
      NOW
    );
    expect(p.engagement.visitorIdentities).toBe(2);
    expect(p.engagement.possibleAdditionalVisitor).toBe(true);
    expect(p.intentScore).toBe(2 + INTENT_WEIGHTS.repeatSession + INTENT_WEIGHTS.possibleSecondVisitor);
  });

  it("beacon-less views collapse into one session per 30-minute gap — scanner pairs never read as repeat", () => {
    const pair = deriveIntent(
      facts({ views: [view({ sessionId: null, visitorId: null }), view({ sessionId: null, visitorId: null, viewedAt: new Date(h(0.15).getTime() + 74_000) })] }),
      NOW
    );
    expect(pair.engagement.sessions).toBe(1);
    expect(pair.engagement.repeat).toBe(false);
    expect(pair.engagement.visitorIdentities).toBe(0);
    expect(pair.engagement.unknownIdentityViews).toBe(2);
    const nextDay = deriveIntent(
      facts({ views: [view({ sessionId: null, visitorId: null }), view({ sessionId: null, visitorId: null, viewedAt: h(26) })] }),
      NOW
    );
    expect(nextDay.engagement.sessions).toBe(2);
    const mixed = deriveIntent(
      facts({ views: [view({ sessionId: null, visitorId: null }), view({ sessionId: "s9", viewedAt: new Date(h(0.15).getTime() + 60_000) })] }),
      NOW
    );
    expect(mixed.engagement.sessions).toBe(2);
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
    expect(p.priorityTier).toBe(5);
    expect(p.recommendedAction).toMatch(/no recorded send/);
    const c = summarizeCohort([p], NOW);
    expect(c.contacted).toBe(0);
    expect(c.viewed).toBe(0);
    expect(c.prospectsWithAnyView).toBe(1);
    expect(c.unresolvedSessions).toBe(2);
  });

  it("spec 099: unattributed activity is labeled Unresolved, never High intent — whatever it scores", () => {
    const teamMoza = deriveIntent(
      facts({
        sentAts: [],
        views: [1, 2, 3, 4].map((i) => view({ sessionId: `s${i}`, visitorId: null, viewedAt: h(i), engagedSeconds: 90, maxScrollPercent: 95 })),
      }),
      NOW
    );
    expect(teamMoza.engagement.sessions).toBe(4);
    expect(teamMoza.intentScore).toBeGreaterThanOrEqual(6);
    expect(teamMoza.intentLabel).toBe("Unresolved");
    expect(teamMoza.priorityTier).toBe(5);
  });
});

describe("contacted state and follow-up cadence derive from the ledger", () => {
  it("contacted is true from an allowed send even when the stage column lags", () => {
    const p = deriveIntent(facts({ stage: "identified", visitedStages: [] }), NOW);
    expect(p.sales.contacted).toBe(true);
    expect(p.sales.touches).toBe(1);
  });

  // NOW is Friday 2026-08-21 12:00Z (08:00 ET). Business days are Mon–Fri ET.
  it("business days: weekends do not count", () => {
    const thu = new Date("2026-08-20T16:00:00Z");
    expect(businessDaysBetween(thu, new Date("2026-08-21T16:00:00Z"))).toBe(1); // Fri
    expect(businessDaysBetween(thu, new Date("2026-08-23T16:00:00Z"))).toBe(1); // Fri, Sat, Sun → 1
    expect(businessDaysBetween(thu, new Date("2026-08-25T16:00:00Z"))).toBe(3); // + Mon, Tue
    expect(businessDaysBetween(thu, thu)).toBe(0);
  });

  it("startOfOperatorDay: midnight ET, not server-local midnight (EDT and EST)", () => {
    expect(startOfOperatorDay(new Date("2026-08-21T04:03:58Z")).toISOString()).toBe("2026-08-21T04:00:00.000Z"); // 00:03 EDT
    expect(startOfOperatorDay(new Date("2026-08-21T03:30:00Z")).toISOString()).toBe("2026-08-20T04:00:00.000Z"); // 23:30 EDT prev day
    expect(startOfOperatorDay(new Date("2026-01-15T12:00:00Z")).toISOString()).toBe("2026-01-15T05:00:00.000Z"); // EST
  });

  it("silent cadence: due after 3 business days, not before; capped at max touches", () => {
    const fresh = deriveIntent(facts({ sentAts: [new Date(NOW.getTime() - 2 * 86_400_000)] }), NOW);
    expect(fresh.followUpDue).toBe(false);
    expect(fresh.priorityTier).toBe(8);
    // Sent Saturday → Mon, Tue, Wed, Thu, Fri = 5 business days by Friday.
    const stale = deriveIntent(facts({ sentAts: [new Date(NOW.getTime() - 6 * 86_400_000)] }), NOW);
    expect(stale.followUpDue).toBe(true);
    expect(stale.priorityTier).toBe(7);
    expect(stale.recommendedAction).toMatch(/new reason/);
    // Sent Monday evening ET: Tue, Wed, Thu = 3 → due Thursday evening, not Wednesday.
    const mon = new Date("2026-08-17T22:00:00Z");
    expect(deriveIntent(facts({ sentAts: [mon] }), new Date("2026-08-19T23:00:00Z")).followUpDue).toBe(false);
    expect(deriveIntent(facts({ sentAts: [mon] }), new Date("2026-08-20T23:00:00Z")).followUpDue).toBe(true);
    const maxed = deriveIntent(
      facts({ sentAts: [20, 16, 12, 9, 6].map((d) => new Date(NOW.getTime() - d * 86_400_000)) }),
      NOW
    );
    expect(maxed.sales.touches).toBe(FOLLOW_UP_RULES.maxTouches);
    expect(maxed.followUpDue).toBe(false);
    expect(maxed.recommendedAction).toMatch(/Max touches/);
  });

  it("engaged cadence: a view after the last send waits two business days — never the next morning", () => {
    const sent = new Date(NOW.getTime() - 10 * 86_400_000);
    const viewedYesterday = deriveIntent(
      facts({ sentAts: [sent], views: [view({ viewedAt: new Date(NOW.getTime() - 30 * 3_600_000) })] }),
      NOW
    );
    expect(viewedYesterday.followUpDue).toBe(false);
    // Viewed Tuesday: Wed, Thu = 2 business days → due Thursday.
    const viewedTue = deriveIntent(
      facts({ sentAts: [sent], views: [view({ viewedAt: new Date("2026-08-18T15:00:00Z") })] }),
      new Date("2026-08-20T16:00:00Z")
    );
    expect(viewedTue.followUpDue).toBe(true);
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
  it("ranks conversation > CTA > high authority+intent > deep > multiple sessions > single > due > silent > uncontacted", () => {
    const items = [
      deriveIntent(facts({ prospectId: "uncontacted", sentAts: [] }), NOW),
      deriveIntent(facts({ prospectId: "silent" }), NOW),
      deriveIntent(facts({ prospectId: "due", sentAts: [new Date(NOW.getTime() - 6 * 86_400_000)] }), NOW),
      deriveIntent(facts({ prospectId: "single", views: [view()] }), NOW),
      deriveIntent(facts({ prospectId: "deep", qualityScore: 20, views: [view({ engagedSeconds: 45 })] }), NOW),
      deriveIntent(facts({ prospectId: "repeat", qualityScore: 20, views: [view(), view({ sessionId: "s2", viewedAt: h(5) })] }), NOW),
      deriveIntent(facts({ prospectId: "hq-hi", views: [view({ engagedSeconds: 90, maxScrollPercent: 90 })] }), NOW),
      deriveIntent(facts({ prospectId: "cta", views: [view({ ctaClicked: true })] }), NOW),
      deriveIntent(facts({ prospectId: "replied", stage: "replied", visitedStages: ["replied"] }), NOW),
    ];
    const order = [...items].sort(compareByPriority).map((p) => p.prospectId);
    expect(order).toEqual(["replied", "cta", "hq-hi", "deep", "repeat", "single", "due", "silent", "uncontacted"]);
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
    const base = { viewed: 0, engaged: 0, replied: 0, meeting: 0, proposal: 0, client: 0, followUpDue: 0, notContacted: 0, auditViews: 0, auditSessions: 0, auditVisitorIdentities: 0, prospectsWithAnyView: 0, preOutreachViews: 0, attributedLinkProspects: 0, unattributedProspects: 0, opens: 0, openedProspects: 0, unresolvedSessions: 0, medianSecondsToFirstView: null, funnel: [] };
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
