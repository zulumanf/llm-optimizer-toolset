/**
 * Known-answer tests for the acquisition funnel, the score-feedback report,
 * and the outreach channel registry (spec 043).
 */
import { describe, expect, it } from "vitest";
import { computeFunnel, type ProspectStageFacts } from "@/lib/prospects/funnel";
import {
  scoreOutcomeReport,
  MIN_COHORT,
  FEEDBACK_EPILOGUE,
  type ScoredOutcomeRow,
} from "@/lib/prospects/score-feedback";
import {
  getEmailChannel,
  hasOptOutMention,
  optOutFooter,
  OUTREACH_SEND_CHANNELS,
} from "@/lib/prospects/channels";

const facts = (
  currentStage: ProspectStageFacts["currentStage"],
  visited: ProspectStageFacts["visitedStages"] = []
): ProspectStageFacts => ({ currentStage, visitedStages: visited });

describe("computeFunnel", () => {
  it("counts ever-reached, not snapshots: a contracted prospect fills every earlier stage", () => {
    const report = computeFunnel([
      facts("contracted", ["researching", "qualified", "contacted", "replied", "contracted"]),
      facts("identified"),
    ]);
    const reached = Object.fromEntries(report.stages.map((s) => [s.stage, s.reached]));
    expect(reached.identified).toBe(2);
    expect(reached.qualified).toBe(1);
    expect(reached.replied).toBe(1);
    expect(reached.contracted).toBe(1);
  });

  it("computes stage-to-stage conversion, null on an empty base — never 0", () => {
    const report = computeFunnel([
      facts("contacted", ["researching", "benchmarking", "qualified", "outreach_ready", "contacted"]),
      facts("qualified", ["researching", "benchmarking", "qualified"]),
    ]);
    const byStage = new Map(report.stages.map((s) => [s.stage, s]));
    expect(byStage.get("identified")!.conversionFromPrevious).toBeNull(); // first stage
    expect(byStage.get("outreach_ready")!.conversionFromPrevious).toBeCloseTo(0.5, 10); // 1 of 2
    expect(byStage.get("contacted")!.conversionFromPrevious).toBe(1); // 1 of 1
    // A real 0% step (1 → 0) is measured; the step after it has a zero
    // base → null, never 0/0.
    expect(byStage.get("replied")!.conversionFromPrevious).toBe(0);
    expect(byStage.get("audit_sent")!.conversionFromPrevious).toBeNull();
  });

  it("counts exits separately without polluting the ladder", () => {
    const report = computeFunnel([
      facts("closed_lost", ["researching", "closed_lost"]),
      facts("identified"),
    ]);
    expect(report.exits).toEqual([{ stage: "closed_lost", count: 1 }]);
    const reached = Object.fromEntries(report.stages.map((s) => [s.stage, s.reached]));
    expect(reached.researching).toBe(1);
    expect(reached.qualified).toBe(0);
  });
});

describe("scoreOutcomeReport", () => {
  const row = (converted: boolean, contactability: number): ScoredOutcomeRow => ({
    converted,
    components: { contactability, buyingSignals: null },
  });

  it("refuses to conclude below the cohort floor", () => {
    const report = scoreOutcomeReport([
      ...Array.from({ length: MIN_COHORT - 1 }, () => row(true, 80)),
      ...Array.from({ length: MIN_COHORT }, () => row(false, 20)),
    ]);
    expect(report.sufficient).toBe(false);
    expect(report.comparisons).toEqual([]);
    expect(report.recommendations[0]).toContain("Insufficient data");
    expect(report.epilogue).toBe(FEEDBACK_EPILOGUE);
  });

  it("recommends in the direction of the delta, with sample sizes, and never writes", () => {
    const report = scoreOutcomeReport([
      ...Array.from({ length: 5 }, () => row(true, 80)),
      ...Array.from({ length: 5 }, () => row(false, 20)),
    ]);
    expect(report.sufficient).toBe(true);
    const contact = report.comparisons.find((c) => c.component === "contactability")!;
    expect(contact.delta).toBeCloseTo(60, 10);
    expect(report.recommendations[0]).toContain("60.0 points higher on contactability");
    expect(report.recommendations[0]).toContain("n=5/5");
    // Null components stay out of the means instead of dragging them to 0.
    const buying = report.comparisons.find((c) => c.component === "buyingSignals")!;
    expect(buying.convertedMean).toBeNull();
    expect(buying.delta).toBeNull();
  });

  it("says so when nothing separates the cohorts", () => {
    const report = scoreOutcomeReport([
      ...Array.from({ length: 5 }, () => row(true, 50)),
      ...Array.from({ length: 5 }, () => row(false, 49)),
    ]);
    expect(report.recommendations[0]).toContain("keep the current weights");
  });
});

describe("outreach channels", () => {
  it("ships manual, mock, and gmail (spec 091); manual never transmits; unknown refused", () => {
    expect(OUTREACH_SEND_CHANNELS.sort()).toEqual(["gmail", "manual", "mock"]);
    expect(getEmailChannel("manual").transmits).toBe(false);
    expect(getEmailChannel("mock").transmits).toBe(true);
    expect(getEmailChannel("gmail").transmits).toBe(true);
    expect(() => getEmailChannel("sendgrid")).toThrow(/Unknown outreach channel/);
  });

  it("opt-out helpers: footer carries the instruction AND the postal address (spec 052)", () => {
    const footer = optOutFooter({
      senderName: "Dana Operator",
      companyName: "AVOS Agency LLC",
      postalAddress: "123 Grand St, Jersey City, NJ 07302",
    });
    expect(hasOptOutMention(footer)).toBe(true);
    expect(footer).toContain("123 Grand St, Jersey City, NJ 07302");
    expect(footer).toContain("AVOS Agency LLC");
    expect(hasOptOutMention("Plain pitch text")).toBe(false);
    expect(hasOptOutMention("Reply UNSUBSCRIBE anytime")).toBe(true);
    expect(hasOptOutMention("you can opt out")).toBe(true);
  });
});
