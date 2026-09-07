/**
 * Spec 121 — executive brief: known-answer tests for the deterministic
 * synthesis. Headline priority, action ranking and truncation, evidence
 * numbers, the diagnose-gated epilogue, and zero-denominator safety.
 * Pure fixtures; no database.
 */
import { describe, expect, it } from "vitest";
import type { CohortSummary, Diagnosis } from "@/lib/prospects/intent";
import { BRIEF_MAX_ACTIONS, BRIEF_VERSION, executiveBrief, type BriefFacts } from "@/lib/prospects/brief";

const EARLY: Diagnosis = {
  verdict: "not_enough_data",
  bottleneck: null,
  reason: "Fewer than 20 contacted — early sample, directional only.",
  review: [],
};
const HEALTHY: Diagnosis = {
  verdict: "healthy",
  bottleneck: null,
  reason: "No step is under-converting against the early benchmarks.",
  review: [],
};

const cohort = (over: Partial<CohortSummary> = {}): CohortSummary => ({
  contacted: 0, viewed: 0, engaged: 0, replied: 0, meeting: 0, proposal: 0, client: 0,
  followUpDue: 0, notContacted: 0, auditViews: 0, auditSessions: 0, auditVisitorIdentities: 0,
  prospectsWithAnyView: 0, preOutreachViews: 0, attributedLinkProspects: 0, unattributedProspects: 0,
  opens: 0, openedProspects: 0, cohortAgeDays: null, medianSecondsToFirstView: null,
  unresolvedSessions: 0, funnel: [], diagnosis: EARLY, ...over,
});

const facts = (over: Partial<BriefFacts> = {}): BriefFacts => ({
  cohortName: "Jersey City · Batch 1", prospectCount: 20, cohort: cohort(),
  repliesWaiting: 0, meetingsToPrepare: 0, approvals: 0, blockedSends: 0, scheduledPending: 0,
  followUpsEligible24h: 0, unresolvedAttribution: 0, expiringAudits: 0, researchQueue: 0,
  gmailHealthy: true, gmailStatus: "active", capUsed24h: 3, capLimit: 20,
  sentToday: 6, quota: 6, quotaStreak: 2, stalledAtOne: 0, businessDay: true, ...over,
});

describe("executiveBrief", () => {
  it("renders a single-line brief with no actions on an empty cohort", () => {
    const b = executiveBrief(facts({ prospectCount: 0 }));
    expect(b.version).toBe(BRIEF_VERSION);
    expect(b.headline).toContain("No prospects in this cohort yet");
    expect(b.actions).toHaveLength(0);
    expect(b.observations).toHaveLength(0);
    expect(b.epilogue).toBeNull();
  });

  it("a blocked transport owns the headline and action #1 even with conversations waiting", () => {
    const b = executiveBrief(
      facts({ gmailHealthy: false, gmailStatus: "authorization_expired", scheduledPending: 4, repliesWaiting: 2 })
    );
    expect(b.headline).toContain("Outbound is blocked");
    expect(b.headline).toContain("authorization expired");
    expect(b.actions[0]!.text).toContain("connect-gmail.ts");
    expect(b.actions[0]!.evidence).toContain("4 scheduled sends waiting");
    expect(b.actions[1]!.text).toContain("Answer 2 replies");
  });

  it("conversations outrank volume: replies and meetings lead the headline and actions", () => {
    const b = executiveBrief(facts({ repliesWaiting: 2, meetingsToPrepare: 1, sentToday: 0 }));
    expect(b.headline).toBe("2 replies to answer and 1 meeting to prepare — conversations before volume.");
    expect(b.actions[0]).toMatchObject({ target: { kind: "filter", patch: { sales: "replied" } } });
    expect(b.actions[0]!.text).toContain("Answer 2 replies");
    expect(b.actions[1]).toMatchObject({ target: { kind: "filter", patch: { sales: "meeting" } } });
  });

  it("an unmet quota on a business day becomes the headline and a linked action with evidence", () => {
    const b = executiveBrief(facts({ sentToday: 2, quotaStreak: 3 }));
    expect(b.headline).toBe("4 sends short of today's quota (2/6) — volume is the lever right now.");
    const send = b.actions.find((a) => a.text.startsWith("Send"))!;
    expect(send.text).toBe("Send 4 more emails today to keep the 3-business-day streak.");
    expect(send.evidence).toBe("2/6 sent today");
    expect(send.target).toEqual({ kind: "filter", patch: { outreach: "not" } });
  });

  it("weekends suppress quota pressure entirely", () => {
    const b = executiveBrief(facts({ sentToday: 0, businessDay: false }));
    expect(b.headline).not.toContain("quota");
    expect(b.actions.find((a) => a.text.startsWith("Send"))).toBeUndefined();
  });

  it("never emits more than the action cap, in rank order", () => {
    const b = executiveBrief(
      facts({ gmailHealthy: false, gmailStatus: null, repliesWaiting: 1, meetingsToPrepare: 1, approvals: 2 })
    );
    expect(b.actions).toHaveLength(BRIEF_MAX_ACTIONS);
    expect(b.actions.map((a) => a.text.split(" ")[0])).toEqual(["Reconnect", "Answer", "Prepare"]);
  });

  it("the early-sample epilogue follows the diagnose gate exactly", () => {
    expect(executiveBrief(facts()).epilogue).toContain("Early sample");
    expect(executiveBrief(facts({ cohort: cohort({ diagnosis: HEALTHY }) })).epilogue).toBeNull();
  });

  it("a diagnosed bottleneck surfaces as headline, action, and bad observation with its review list", () => {
    const diagnosis: Diagnosis = {
      verdict: "possible_bottleneck",
      bottleneck: "outreach",
      reason: "10% of contacted prospects' audits received a view.",
      review: ["targeting", "subject line"],
    };
    const b = executiveBrief(facts({ cohort: cohort({ contacted: 30, viewed: 3, diagnosis }) }));
    expect(b.headline).toContain("Possible bottleneck: outreach");
    const act = b.actions.find((a) => a.text.startsWith("Work the outreach bottleneck"))!;
    expect(act.text).toContain("targeting, subject line");
    expect(act.evidence).toBe(diagnosis.reason);
    const obs = b.observations.find((o) => o.tone === "bad" && o.text.includes("bottleneck"))!;
    expect(obs.evidence).toContain("targeting");
    expect(b.epilogue).toBeNull();
  });

  it("states no rates on zero denominators and carries evidence counts verbatim", () => {
    const zero = executiveBrief(facts({ cohort: cohort({ contacted: 0, viewed: 0 }) }));
    for (const o of zero.observations) {
      expect(o.text).not.toContain("NaN");
      expect(o.evidence).not.toContain("NaN");
    }
    const b = executiveBrief(facts({ cohort: cohort({ contacted: 32, viewed: 13, diagnosis: HEALTHY }) }));
    const view = b.observations.find((o) => o.text.includes("viewed their audit"))!;
    expect(view.text).toContain("41%");
    expect(view.evidence).toBe("13/32");
  });

  it("healthy cohort with quota met reads as on-track with good observations", () => {
    const b = executiveBrief(
      facts({ cohort: cohort({ contacted: 32, viewed: 13, engaged: 8, replied: 3, meeting: 1, diagnosis: HEALTHY }) })
    );
    expect(b.headline).toBe("On track — no funnel step is under-converting. Keep the inputs up.");
    expect(b.observations.find((o) => o.text.includes("Quota streak at 2 business days"))).toBeDefined();
    expect(b.observations.find((o) => o.text.includes("3 replies and 1 meeting from 32 contacted prospects"))).toBeDefined();
  });
});
