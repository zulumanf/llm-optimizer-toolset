/**
 * Spec 131 — pure engagement rules. The load-bearing cases: onboarding can
 * never be "complete" by assertion, the commercial gate never passes on an
 * unsigned contract, and a remeasurement over a different question set is
 * NON-COMPARABLE rather than a fake progress percentage.
 */
import { describe, expect, it } from "vitest";
import {
  assessMeasurementComparability,
  commercialGate,
  compareMeasurements,
  composeWeeklyUpdate,
  deriveRenewalStatus,
  deriveStage,
  measurementSchedule,
  nextAction,
  onboardingChecklist,
  onboardingComplete,
  termDates,
  type MeasurementSnapshot,
} from "@/lib/engagements/rules";

const baseOnboarding = {
  contractStatus: "signed" as const,
  paymentsReceivedCents: 750_000,
  activationOverrideReason: null,
  subjectLinked: true,
  primaryContactNamed: true,
  marketDefinitionConfirmed: true,
  exclusivityStatus: "active" as const,
  exclusivityConflictFree: true,
  priorityItems: 2,
  assetItems: 3,
  accessRequestedOpen: 0,
  baselineFrozen: true,
  planItems: 3,
};

function snapshot(over: Partial<MeasurementSnapshot> = {}): MeasurementSnapshot {
  return {
    methodologyVersion: "engagement-measurement-v1",
    runId: "run-a",
    sourceProjectId: "p",
    provider: "openai",
    models: ["gpt-5.4-mini-2026-03-17+search"],
    repetitions: 4,
    promptSetVersionId: "psv-1",
    questionCount: 2,
    answerCount: 8,
    capturedAt: "2026-08-31T11:00:00.000Z",
    subject: { companyId: "blu", name: "Blu House Properties", aliases: ["Ryan Ogle"], recommendedCount: 1, distinctQuestions: 1 },
    competitors: [{ companyId: "josh", name: "Josh May", aliases: [], recommendedCount: 3, distinctQuestions: 2 }],
    questions: [
      { promptId: "q1", text: "best agent eastown", category: "neighborhood", answerCount: 4, subjectRecommended: 1, competitorRecommended: { josh: 2 }, responseIds: ["r1"] },
      { promptId: "q2", text: "best luxury agent", category: "luxury", answerCount: 4, subjectRecommended: 0, competitorRecommended: { josh: 1 }, responseIds: ["r2"] },
    ],
    versions: { scoringVersion: "v1.1", parserVersions: ["mention-parser-v2+llm"], classifierModels: ["m"], resolverPolicy: "verified-lead-agent-alias-v1" },
    ...over,
  };
}

describe("term dates and schedule", () => {
  it("derives a 90-day term with review three weeks out and two remeasurements", () => {
    const dates = termDates("2026-09-08");
    expect(dates).toEqual({ endsOn: "2026-12-07", renewalReviewOn: "2026-11-16" });
    const plan = measurementSchedule("2026-09-08", dates.endsOn);
    expect(plan.map((p) => [p.role, p.scheduledFor])).toEqual([
      ["midpoint", "2026-10-23"],
      ["final", "2026-11-27"],
    ]);
  });
});

describe("commercial gate", () => {
  it("needs a signed contract AND a payment (or a written override)", () => {
    expect(commercialGate({ contractStatus: "sent", paymentsReceivedCents: 750_000, activationOverrideReason: null }).ready).toBe(false);
    expect(commercialGate({ contractStatus: "signed", paymentsReceivedCents: 0, activationOverrideReason: null }).ready).toBe(false);
    expect(commercialGate({ contractStatus: "signed", paymentsReceivedCents: 0, activationOverrideReason: "Founder: invoice net-7, kickoff Monday" }).ready).toBe(true);
    expect(commercialGate({ contractStatus: "signed", paymentsReceivedCents: 750_000, activationOverrideReason: null }).ready).toBe(true);
  });
  it("an override never substitutes for the contract", () => {
    expect(commercialGate({ contractStatus: "draft", paymentsReceivedCents: 0, activationOverrideReason: "trust me" }).ready).toBe(false);
  });
});

describe("onboarding checklist", () => {
  it("is complete only when every criterion holds", () => {
    expect(onboardingComplete(onboardingChecklist(baseOnboarding))).toBe(true);
    for (const broken of [
      { marketDefinitionConfirmed: false },
      { baselineFrozen: false },
      { accessRequestedOpen: 1 },
      { priorityItems: 0 },
      { exclusivityStatus: "reserved" as const },
      { exclusivityConflictFree: false },
      { planItems: 0 },
    ]) {
      const items = onboardingChecklist({ ...baseOnboarding, ...broken });
      expect(onboardingComplete(items), JSON.stringify(broken)).toBe(false);
    }
  });
});

describe("measurement comparability", () => {
  it("grades identical instruments high", () => {
    expect(assessMeasurementComparability(snapshot(), snapshot({ runId: "run-b" })).grade).toBe("high");
  });
  it("refuses a different question set, provider, or resolver policy", () => {
    expect(assessMeasurementComparability(snapshot(), snapshot({ promptSetVersionId: "psv-2" })).grade).toBe("not_comparable");
    expect(assessMeasurementComparability(snapshot(), snapshot({ provider: "perplexity" })).grade).toBe("not_comparable");
    const policy = snapshot();
    policy.versions = { ...policy.versions, resolverPolicy: "other" };
    const verdict = assessMeasurementComparability(snapshot(), policy);
    expect(verdict.grade).toBe("not_comparable");
    expect(verdict.reasons.join(" ")).toMatch(/resolution policy/);
  });
  it("degrades on model change, partial runs and alias drift", () => {
    expect(assessMeasurementComparability(snapshot(), snapshot({ models: ["gpt-6"] })).grade).toBe("medium");
    expect(assessMeasurementComparability(snapshot(), snapshot({ answerCount: 4 })).grade).toBe("low");
    const drift = snapshot();
    drift.subject = { ...drift.subject, aliases: ["Ryan Ogle", "Blu House Team"] };
    expect(assessMeasurementComparability(snapshot(), drift).grade).toBe("medium");
  });
});

describe("measurement comparison", () => {
  it("reports movement per entity, question and category without causality", () => {
    const after = snapshot({ runId: "run-b" });
    after.subject = { ...after.subject, recommendedCount: 3, distinctQuestions: 2 };
    after.questions = after.questions.map((q) => ({ ...q, subjectRecommended: q.promptId === "q2" ? 2 : 1 }));
    const cmp = compareMeasurements(snapshot(), after);
    expect(cmp.subject.delta).toBe(2);
    expect(cmp.gainedQuestions).toEqual(["best luxury agent"]);
    expect(cmp.lostQuestions).toEqual([]);
    expect(cmp.categories.find((c) => c.category === "luxury")?.delta).toBe(2);
    expect(cmp.competitors[0]?.next).toBe(3);
    expect(cmp.statement).toMatch(/recommended in 3 of 8/);
    expect(cmp.statement).not.toMatch(/caused|because of our/i);
    expect(cmp.statement).toMatch(/not an attribution/);
  });
});

describe("renewal and stage by calendar", () => {
  const base = { endsOn: "2026-12-07", renewalReviewOn: "2026-11-16", stored: "not_due" as const, stage: "active" as const };
  it("becomes due at review date, lapsed after the end, and keeps explicit decisions", () => {
    expect(deriveRenewalStatus(base, "2026-10-01")).toBe("not_due");
    expect(deriveRenewalStatus(base, "2026-11-16")).toBe("due");
    expect(deriveRenewalStatus(base, "2026-12-08")).toBe("lapsed");
    expect(deriveRenewalStatus({ ...base, stored: "offered" }, "2026-12-08")).toBe("offered");
    expect(deriveStage("active", base.renewalReviewOn, "2026-11-20")).toBe("renewal_review");
    expect(deriveStage("onboarding", base.renewalReviewOn, "2026-11-20")).toBe("onboarding");
  });
});

describe("weekly update", () => {
  it("says so when nothing meaningful happened", () => {
    const text = composeWeeklyUpdate({
      clientName: "Blu House Properties",
      weekEnding: "2026-09-18",
      done: [],
      inProgress: ["Align person/team identity on owned pages"],
      needFromYou: [],
      measurement: null,
      next: ["Profile consistency audit"],
    });
    expect(text).toMatch(/Nothing material changed this week/);
    expect(text).toMatch(/NEED FROM YOU\n- Nothing is waiting on you\./);
  });
});

describe("next action", () => {
  it("walks the operator through the gates in order", () => {
    const checklist = onboardingChecklist({ ...baseOnboarding, baselineFrozen: false });
    expect(
      nextAction({ stage: "signed", commercial: { ready: false, reasons: ["Contract is \"sent\", not signed."] }, checklist, openApprovals: 0, blockedOnClient: 0, measurementDue: false, renewalStatus: "not_due" })
    ).toMatch(/commercial gate/);
    expect(
      nextAction({ stage: "onboarding", commercial: { ready: true, reasons: [] }, checklist, openApprovals: 0, blockedOnClient: 0, measurementDue: false, renewalStatus: "not_due" })
    ).toMatch(/baseline frozen/);
    expect(
      nextAction({ stage: "active", commercial: { ready: true, reasons: [] }, checklist, openApprovals: 2, blockedOnClient: 0, measurementDue: false, renewalStatus: "not_due" })
    ).toMatch(/await client approval/);
  });
});
