/**
 * Spec 154 — pure delivery rules: statistics (known answers), price bands,
 * journey derivation, plan item state, weekly/welcome/final-review bodies,
 * operator-note guard, comparable-rate selection, segment breakdowns, and
 * the client question review over the synthetic 64-question fixture.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  OUTCOME_NOT_AUTOMATIC,
  composeFinalReviewBody,
  composeWeeklyBody,
  composeWelcome,
  deliveryJourney,
  differenceInterval,
  latestComparable,
  moneyMentions,
  nextCheckinDue,
  offboardingChecklist,
  operatorNoteIssues,
  parsePriceBand,
  phaseProgress,
  phaseWindows,
  planItemState,
  protocolMissing,
  rateView,
  segmentBreakdown,
  wilsonInterval,
  type JourneyInput,
} from "@/lib/engagements/delivery-rules";
import { normalizeDecision, reviewQuestionCsv } from "@/lib/engagements/question-review";
import type { MeasurementSnapshot } from "@/lib/engagements/rules";

const FIXTURE = readFileSync(join(__dirname, "..", "fixtures", "client-delivery", "synthetic-64-seller-questions.csv"), "utf8");

describe("statistics (known answers)", () => {
  it("Wilson 95% interval matches Newcombe (1998) example 81/263", () => {
    const i = wilsonInterval(81, 263)!;
    expect(i.low).toBeCloseTo(0.2553, 3);
    expect(i.high).toBeCloseTo(0.3662, 3);
  });
  it("Wilson handles 0 and n without leaving [0,1]; empty is null", () => {
    expect(wilsonInterval(0, 10)!.low).toBe(0);
    expect(wilsonInterval(10, 10)!.high).toBeCloseTo(1, 9);
    expect(wilsonInterval(0, 0)).toBeNull();
  });
  it("Newcombe hybrid difference interval matches 56/70 − 48/80", () => {
    const d = differenceInterval(48, 80, 56, 70)!;
    expect(d.low).toBeCloseTo(0.0524, 3);
    expect(d.high).toBeCloseTo(0.3339, 3);
  });
});

describe("price bands", () => {
  it("parses ranges and open-ended bands in K/M and commas", () => {
    expect(parsePriceBand("Core $300K–$499K")).toEqual({ min: 300_000, max: 499_000 });
    expect(parsePriceBand("Luxury $750K–$1.49M")).toEqual({ min: 750_000, max: 1_490_000 });
    expect(parsePriceBand("Estate $1.5M+")).toEqual({ min: 1_500_000, max: null });
    expect(parsePriceBand("$250,000 - $299,000")).toEqual({ min: 250_000, max: 299_000 });
    expect(parsePriceBand("Starter homes")).toBeNull();
  });
  it("finds dollar amounts inside question text", () => {
    expect(moneyMentions("Sell my $250K condo or my $1.2M ranch")).toEqual([250_000, 1_200_000]);
  });
});

const baseJourney: JourneyInput = {
  stage: "onboarding",
  commercialReady: true,
  commercialReasons: [],
  portalGrants: 0,
  welcomeSent: false,
  intakeConfirmed: false,
  questionSet: null,
  protocol: null,
  baselineFrozen: false,
  roadmapPublished: false,
  lastWeeklySentOn: null,
  nextCheckinOn: null,
  finalMeasured: false,
  finalReviewSent: false,
  today: "2026-10-20",
};

describe("journey", () => {
  it("a signed engagement without payment is blocked at the commercial gate", () => {
    const steps = deliveryJourney({ ...baseJourney, stage: "signed", commercialReady: false, commercialReasons: ["No payment received has been recorded."] });
    expect(steps[0]).toMatchObject({ key: "commercial", state: "blocked" });
    expect(steps.slice(1).every((s) => s.state === "upcoming")).toBe(true);
  });
  it("exactly one current step, in order; client actions only where the client acts", () => {
    const steps = deliveryJourney({ ...baseJourney, portalGrants: 1, welcomeSent: true, intakeConfirmed: true, questionSet: { versionId: "v", questionCount: 64, approved: false, changesRequested: false } });
    expect(steps.filter((s) => s.state === "current" || s.state === "blocked")).toHaveLength(1);
    const current = steps.find((s) => s.state === "current")!;
    expect(current.key).toBe("questions");
    expect(current.clientAction).toMatch(/Review the proposed questions/);
    expect(steps.find((s) => s.key === "baseline")!.clientAction).toBeNull();
  });
  it("changes requested on the questions shows as blocked", () => {
    const steps = deliveryJourney({ ...baseJourney, portalGrants: 1, welcomeSent: true, intakeConfirmed: true, questionSet: { versionId: "v", questionCount: 64, approved: false, changesRequested: true } });
    expect(steps.find((s) => s.key === "questions")!.state).toBe("blocked");
  });
  it("interrupted onboarding resumes where it stopped (derived, not stored)", () => {
    const steps = deliveryJourney({ ...baseJourney, portalGrants: 1, welcomeSent: true, intakeConfirmed: true, questionSet: { versionId: "v", questionCount: 64, approved: true, changesRequested: false }, protocol: { status: "draft", questionSetApproved: true } });
    expect(steps.find((s) => s.state === "current")!.key).toBe("protocol");
  });
});

describe("plan items", () => {
  it("derives one client state from the item and its task", () => {
    expect(planItemState({ status: "planned", task: null })).toBe("proposed");
    expect(planItemState({ status: "in_progress", task: { status: "in_progress", blockedReason: null, clientApproval: "not_required" } })).toBe("in_progress");
    expect(planItemState({ status: "in_progress", task: { status: "approved", blockedReason: null, clientApproval: "required" } })).toBe("blocked");
    expect(planItemState({ status: "in_progress", task: { status: "in_progress", blockedReason: "client_access", clientApproval: "approved" } })).toBe("blocked");
    expect(planItemState({ status: "done", task: { status: "done", blockedReason: null, clientApproval: "approved" } })).toBe("completed");
    expect(planItemState({ status: "dropped", task: null })).toBe("dropped");
  });
  it("phases cover days 1–30, 31–60, 61–90 from the start date", () => {
    const w = phaseWindows("2026-11-01");
    expect(w.map((x) => [x.from, x.to])).toEqual([["2026-11-01", "2026-11-30"], ["2026-12-01", "2026-12-30"], ["2026-12-31", "2027-01-29"]]);
    const p = phaseProgress([{ phase: "foundation", state: "completed" }, { phase: "foundation", state: "blocked" }, { phase: "authority", state: "dropped" }]);
    expect(p[0]).toMatchObject({ total: 2, completed: 1, blocked: 1 });
    expect(p[1]!.total).toBe(0);
  });
  it("check-ins: planned date wins, else 14 days after the last held one", () => {
    expect(nextCheckinDue({ startsOn: "2026-11-01", planned: ["2026-11-20", "2026-11-10"], lastHeld: null })).toEqual({ date: "2026-11-10", scheduled: true });
    expect(nextCheckinDue({ startsOn: "2026-11-01", planned: [], lastHeld: "2026-11-12" })).toEqual({ date: "2026-11-26", scheduled: false });
  });
});

describe("client text", () => {
  it("weekly update never invents a visibility change", () => {
    const body = composeWeeklyBody({
      clientName: "Synthetic Seller Team",
      periodStart: "2026-11-02",
      periodEnd: "2026-11-08",
      intro: "",
      done: [{ taskId: "t1", title: "Publish seller FAQ", targetUrl: "https://example.test/sell", after: "FAQ live", evidenceCount: 2 }],
      inProgress: [],
      blocked: [{ taskId: "t2", title: "Fix profile", reason: "client_access", note: "Invite us as editor", onClient: true }],
      approvals: [{ taskId: "t3", title: "About page wording" }],
      measurements: [],
      baselineFrozen: true,
      dueNext: [],
      nextCheckinOn: "2026-11-12",
    });
    expect(body.text).toMatch(/No comparable measurement was taken this week, so no change in AI visibility is reported/);
    expect(body.text).toMatch(/Publish seller FAQ \(https:\/\/example.test\/sell\) — now: FAQ live/);
    expect(body.text).toMatch(/Approve or edit: About page wording/);
    expect(body.text).toMatch(/Check-in on 2026-11-12/);
    expect(body.text).not.toMatch(/%/);
    expect(body.refs.map((r) => r.id)).toEqual(["t1", "t2", "t3"]);
  });
  it("before the baseline the measurement line says results are not measured yet", () => {
    const body = composeWeeklyBody({ clientName: "X", periodStart: "a", periodEnd: "b", intro: "", done: [], inProgress: [], blocked: [], approvals: [], measurements: [], baselineFrozen: false, dueNext: [], nextCheckinOn: null });
    expect(body.text).toMatch(/baseline has not been measured yet/);
    expect(body.text).toMatch(/Nothing material changed this week/);
  });
  it("non-comparable measurements are reported without a delta", () => {
    const body = composeWeeklyBody({ clientName: "X", periodStart: "a", periodEnd: "b", intro: "", done: [], inProgress: [], blocked: [], approvals: [], measurements: [{ measurementId: "m", role: "adhoc", statement: "should not appear", grade: "not_comparable" }], baselineFrozen: true, dueNext: [], nextCheckinOn: null });
    expect(body.text).toMatch(/not comparable with the baseline/);
    expect(body.text).not.toMatch(/should not appear/);
  });
  it("operator notes refuse percentages and causal claims", () => {
    expect(operatorNoteIssues("Great week on the FAQ.")).toEqual([]);
    expect(operatorNoteIssues("You are up 12% now")).toHaveLength(1);
    expect(operatorNoteIssues("Our FAQ led to more recommendations").length).toBeGreaterThan(0);
  });
  it("welcome links to /portal only and never asks for a password", () => {
    const w = composeWelcome({ clientName: "Synthetic Seller Team", contactName: "Alex Doe", agencyContactName: "Founder", marketName: "Test Metro", scopeSummary: "Scope.", startsOn: "2026-11-01", endsOn: "2027-01-30", portalUrl: "https://app.example.test/portal", nextAction: "Review details.", firstCheckinOn: "2026-11-05" });
    expect(w.text).toMatch(/^Hi Alex,/);
    expect(w.text).toMatch(/https:\/\/app.example.test\/portal/);
    expect(w.text).toMatch(/never ask for a password/);
  });
  it("protocol requires contract-specific fields and at least one name variant", () => {
    const missing = protocolMissing({ model: "m", geographicContext: "", baselineWindow: "w", finalWindow: "w", recommendationRubric: "r", comparisonRules: "c", caveats: "c", adjudication: "a", successCriteria: "", entityAliases: [] });
    expect(missing).toEqual(["geographicContext", "successCriteria", "entityAliases"]);
  });
  it("offboarding never marks exports done automatically", () => {
    const items = offboardingChecklist({ openTasks: 0, finalMeasured: true, finalReviewSent: true, portalGrants: 0, stage: "completed", openMeetings: 0 });
    expect(items.find((i) => i.key === "exports")!.done).toBe(false);
  });
});

function snap(over: Partial<MeasurementSnapshot> = {}): MeasurementSnapshot {
  return {
    methodologyVersion: "engagement-measurement-v1",
    runId: "r",
    sourceProjectId: "p",
    provider: "openai",
    models: ["gpt-x"],
    repetitions: 4,
    promptSetVersionId: "v",
    questionCount: 2,
    answerCount: 8,
    capturedAt: null,
    subject: { companyId: "s", name: "Subject", aliases: [], recommendedCount: 3, distinctQuestions: 1 },
    competitors: [{ companyId: "c", name: "Rival", aliases: [], recommendedCount: 5, distinctQuestions: 2 }],
    questions: [
      { promptId: "q1", text: "a", category: null, answerCount: 4, subjectRecommended: 3, competitorRecommended: { c: 2 }, responseIds: [], segment: { priceTier: "$300K–$499K", neighborhood: "A", audience: "seller", propertyType: null } },
      { promptId: "q2", text: "b", category: null, answerCount: 4, subjectRecommended: 0, competitorRecommended: { c: 3 }, responseIds: [] },
    ],
    versions: { scoringVersion: "v1.1", parserVersions: [], classifierModels: [], resolverPolicy: "x" },
    ...over,
  };
}

describe("results", () => {
  it("no baseline → pending; never a zero", () => {
    expect(latestComparable([])).toEqual({ baseline: null, latest: null });
    expect(rateView(snap({ answerCount: 0 }))).toBeNull();
  });
  it("latest comparable skips non-comparable measurements", () => {
    const b = { id: "b", role: "baseline", status: "frozen", frozenAt: new Date("2026-11-01"), snapshot: snap(), comparability: null };
    const nc = { id: "n", role: "adhoc", status: "non_comparable", frozenAt: new Date("2026-12-01"), snapshot: snap(), comparability: { grade: "not_comparable" as const, reasons: ["x"] } };
    const ok = { id: "o", role: "midpoint", status: "frozen", frozenAt: new Date("2026-11-20"), snapshot: snap(), comparability: { grade: "high" as const, reasons: [] } };
    expect(latestComparable([b, nc]).latest!.id).toBe("b");
    expect(latestComparable([b, nc, ok]).latest!.id).toBe("o");
  });
  it("segment breakdown groups frozen attributes; missing ones are Unspecified", () => {
    const rows = segmentBreakdown(snap(), "priceTier");
    expect(rows).toEqual([
      { segment: "$300K–$499K", questions: 1, answers: 4, recommended: 3, rate: 0.75, competitorRecommended: { c: 2 } },
      { segment: "Unspecified", questions: 1, answers: 4, recommended: 0, rate: 0, competitorRecommended: { c: 3 } },
    ]);
  });
  it("Day-90 review states the outcome is not automatic and reports no delta when not comparable", () => {
    const b = rateView(snap())!;
    const body = composeFinalReviewBody({ clientName: "X", baseline: b, final: b, comparability: { grade: "not_comparable", reasons: ["provider changed"] }, gainedQuestions: [], lostQuestions: [], deliveredWork: [], successCriteria: "Agreed threshold text", externalNote: null });
    expect(body.text).toContain(OUTCOME_NOT_AUTOMATIC);
    expect(body.text).toMatch(/not comparable with the baseline/);
    expect(body.text).not.toMatch(/Observed change/);
  });
});

describe("client question review (synthetic 64-question fixture)", () => {
  const brands = [{ id: "s", name: "Synthetic Realty", aliases: ["Jordan Synthetic"] }, { id: "c", name: "Rival Homes", aliases: [] }];
  const opts = { minPropertyValueUsd: 300_000, brands, requireSellerIntent: true, defaultAudience: "seller" };

  it("accepts all 64 questions with the right segment counts", () => {
    const r = reviewQuestionCsv(FIXTURE, opts);
    expect(r.ok).toBe(true);
    expect(r.rows).toHaveLength(64);
    expect(Object.fromEntries(r.segments.map((s) => [s.priceTier, s.count]))).toEqual({
      "Core $300K–$499K": 24,
      "Move-up $500K–$749K": 16,
      "Luxury $750K–$1.49M": 16,
      "Estate $1.5M+": 8,
    });
    expect(r.rows.every((x) => x.audience === "seller" && x.neighborhood)).toBe(true);
  });

  it("blocks duplicates, branded wording, unresolved decisions and below-floor bands; excludes removals", () => {
    const csv = [
      "segment,neighborhood,question,client_decision,client_comment",
      "Core $300K–$499K,A,Who should I hire to sell my home in A?,Approved,",
      "Core $300K–$499K,A,who should I hire to sell my home in  A?,Pending,",
      "Core $300K–$499K,B,Is Synthetic Realty good for selling in B?,Pending,",
      "Core $300K–$499K,C,Best listing agent in C?,Revise,shorter please",
      "Core $300K–$499K,Metro D,Best listing agent in Metro D?,Check service area,",
      "Starter $200K–$299K,E,Best listing agent to sell in E?,Pending,",
      "Core $300K–$499K,F,Who sells $250K condos in F?,Pending,",
      "Core $300K–$499K,G,Remove me please sell,Remove,",
      "Core $300K–$499K,H,What is the weather in H?,Pending,",
    ].join("\n");
    const r = reviewQuestionCsv(csv, opts);
    expect(r.ok).toBe(false);
    const blocking = r.issues.filter((i) => i.severity === "blocking").map((i) => `${i.line}:${i.message}`);
    expect(blocking.some((m) => m.startsWith("3:Duplicate of line 2"))).toBe(true);
    expect(blocking.some((m) => m.startsWith("4:") && m.includes("Synthetic Realty"))).toBe(true);
    expect(blocking.some((m) => m.startsWith("5:") && m.includes("revision"))).toBe(true);
    expect(blocking.some((m) => m.startsWith("6:") && m.includes("in scope"))).toBe(true);
    expect(blocking.some((m) => m.startsWith("7:") && m.includes("below the agreed minimum"))).toBe(true);
    expect(blocking.some((m) => m.startsWith("8:") && m.includes("$250,000"))).toBe(true);
    expect(r.excluded.map((x) => x.line)).toEqual([9]);
    expect(r.issues.some((i) => i.line === 10 && i.severity === "warning" && /seller-intent/.test(i.message))).toBe(true);
  });

  it("no floor recorded → the floor is not enforced (client-specific rules stay data)", () => {
    const r = reviewQuestionCsv("question,segment\nBest agent to sell my $200K home?,Starter $150K–$299K", { ...opts, minPropertyValueUsd: null });
    expect(r.ok).toBe(true);
  });

  it("refuses a file without a question column and unknown decisions", () => {
    expect(reviewQuestionCsv("a,b\n1,2", opts).ok).toBe(false);
    expect(normalizeDecision("maybe")).toBeNull();
    expect(normalizeDecision("Check service area")).toBe("check_service_area");
  });
});

describe("generic prompt import keeps segment columns (spec 154)", () => {
  it("carries audience/price_tier/neighborhood from CSV and leaves plain lines untouched", async () => {
    const { parsePromptImport } = await import("@/lib/prompts/import-parse");
    const csv = parsePromptImport("text,category,price_tier,neighborhood,audience\nWho should sell my home in A?,recommendation,$300K–$499K,A,seller");
    expect(csv.rows[0]!.segment).toEqual({ audience: "seller", priceTier: "$300K–$499K", neighborhood: "A", propertyType: null });
    const lines = parsePromptImport("best agent to sell my home?");
    expect(lines.rows[0]!.segment).toBeUndefined();
  });
});
