import { describe, expect, it } from "vitest";
import {
  addBusinessDays,
  deterministicOffsetMinutes,
  isBusinessDay,
  nextMorningSlot,
  timezoneForState,
  usFederalHolidays,
} from "@/lib/prospects/business-days";
import { classifyOpen, evaluateEngagement, type EngagementFacts } from "@/lib/prospects/engagement-state";
import {
  followupStartsNewThread,
  followupTemplateFor,
  lintFollowupCopy,
  qaFollowupEvidence,
  renderFollowup,
} from "@/lib/prospects/followup-templates";
import { FOLLOWUP_TEMPLATE_VERSIONS, MISMATCH_THRESHOLDS } from "@/lib/prospects/constants";
import type { MismatchEvidenceSnapshot } from "@/lib/prospects/mismatch";

const NY = "America/New_York";
const LA = "America/Los_Angeles";

describe("business days — weekends, U.S. federal holidays, recipient timezone", () => {
  it("knows 2026 holidays with observed dates", () => {
    const h = usFederalHolidays(2026);
    expect(h.has("2026-09-07")).toBe(true); // Labor Day
    expect(h.has("2026-07-03")).toBe(true); // July 4 falls on Saturday → observed Friday
    expect(h.has("2026-11-26")).toBe(true); // Thanksgiving
    expect(h.has("2026-01-19")).toBe(true); // MLK
    expect(h.has("2026-12-25")).toBe(true);
  });
  it("cadence for the Sep 1 / 2 / 3 cohort skips the weekend and Labor Day", () => {
    const day = (iso: string, n: number, tz = NY): string =>
      addBusinessDays(new Date(iso), n, tz).toISOString().slice(0, 10);
    expect(day("2026-09-01T13:07:00Z", 3)).toBe("2026-09-04");
    expect(day("2026-09-02T13:07:00Z", 3)).toBe("2026-09-08");
    expect(day("2026-09-03T13:07:00Z", 3)).toBe("2026-09-09");
    expect(day("2026-09-04T13:07:00Z", 4)).toBe("2026-09-11");
  });
  it("business day is evaluated on the recipient's local date", () => {
    // 05:00Z Saturday Sep 5 is still Friday evening in Los Angeles, Saturday in New York.
    expect(isBusinessDay(new Date("2026-09-05T05:00:00Z"), LA)).toBe(true);
    expect(isBusinessDay(new Date("2026-09-05T05:00:00Z"), NY)).toBe(false);
    expect(isBusinessDay(new Date("2026-09-07T15:00:00Z"), NY)).toBe(false);
  });
  it("next morning slot rolls over weekends/holidays and lands at 09:00 + offset local", () => {
    const slot = nextMorningSlot(new Date("2026-09-05T15:00:00Z"), { tz: LA, startHour: 9, offsetMinutes: 41 });
    expect(slot.toISOString()).toBe("2026-09-08T16:41:00.000Z"); // Tue 09:41 PDT
    const same = nextMorningSlot(new Date("2026-09-08T12:00:00Z"), { tz: LA, startHour: 9, offsetMinutes: 41 });
    expect(same.toISOString()).toBe("2026-09-08T16:41:00.000Z");
    const past = nextMorningSlot(new Date("2026-09-08T17:00:00Z"), { tz: LA, startHour: 9, offsetMinutes: 41 });
    expect(past.toISOString()).toBe("2026-09-09T16:41:00.000Z");
  });
  it("dispersion is deterministic and inside the window", () => {
    const a = deterministicOffsetMinutes("seq-a", 3, 88);
    expect(a).toBe(deterministicOffsetMinutes("seq-a", 3, 88));
    expect(a).toBeGreaterThanOrEqual(3);
    expect(a).toBeLessThanOrEqual(88);
    expect(new Set(["a", "b", "c", "d", "e"].map((s) => deterministicOffsetMinutes(s, 3, 88))).size).toBeGreaterThan(1);
  });
  it("maps states to zones with an operator fallback", () => {
    expect(timezoneForState("NV")).toBe(LA);
    expect(timezoneForState("co")).toBe("America/Denver");
    expect(timezoneForState(null)).toBe(NY);
  });
});

const SENT = new Date("2026-09-01T13:07:00Z");
const min = (m: number): Date => new Date(SENT.getTime() + m * 60_000);
const HUMAN_UA = "Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)";
const facts = (over: Partial<EngagementFacts>): EngagementFacts => ({
  sends: [{ id: "s1", sentAt: SENT }],
  opens: [],
  auditMeaningfullyEngaged: false,
  replies: [],
  stopReason: null,
  pausedUntil: null,
  now: min(3 * 24 * 60),
  ...over,
});

describe("engagement state — deterministic, opens are noisy", () => {
  it("scanner UA and in-window opens are discounted", () => {
    expect(classifyOpen({ sendId: "s1", openedAt: min(30), userAgent: "Mozilla/5.0" }, SENT)).toBe("scanner");
    expect(classifyOpen({ sendId: "s1", openedAt: min(30), userAgent: null }, SENT)).toBe("scanner");
    expect(classifyOpen({ sendId: "s1", openedAt: min(2), userAgent: HUMAN_UA }, SENT)).toBe("scanner");
    expect(classifyOpen({ sendId: "s1", openedAt: min(30), userAgent: HUMAN_UA }, SENT)).toBe("credible");
  });
  it("a single ambiguous open is NO_MEANINGFUL_ENGAGEMENT", () => {
    const v = evaluateEngagement(facts({ opens: [{ sendId: "s1", openedAt: min(45), userAgent: HUMAN_UA }] }));
    expect(v.state).toBe("NO_MEANINGFUL_ENGAGEMENT");
    expect(v.credibleOpens).toBe(1);
  });
  it("two credible opens ≥ 10 min apart count; two within 5 min do not", () => {
    const yes = evaluateEngagement(facts({ opens: [
      { sendId: "s1", openedAt: min(45), userAgent: HUMAN_UA },
      { sendId: "s1", openedAt: min(60), userAgent: HUMAN_UA },
    ] }));
    expect(yes.state).toBe("MEANINGFUL_ENGAGEMENT");
    const no = evaluateEngagement(facts({ opens: [
      { sendId: "s1", openedAt: min(45), userAgent: HUMAN_UA },
      { sendId: "s1", openedAt: min(49), userAgent: HUMAN_UA },
    ] }));
    expect(no.state).toBe("NO_MEANINGFUL_ENGAGEMENT");
  });
  it("scanner-only activity never counts, even repeated", () => {
    const v = evaluateEngagement(facts({ opens: [
      { sendId: "s1", openedAt: min(1), userAgent: HUMAN_UA },
      { sendId: "s1", openedAt: min(2), userAgent: HUMAN_UA },
      { sendId: "s1", openedAt: min(90), userAgent: "Mozilla/5.0" },
      { sendId: "s1", openedAt: min(200), userAgent: "Mozilla/5.0" },
    ] }));
    expect(v.state).toBe("NO_MEANINGFUL_ENGAGEMENT");
    expect(v.discountedOpens).toBe(4);
  });
  it("one credible open plus a meaningful attributed audit view counts", () => {
    const v = evaluateEngagement(facts({
      opens: [{ sendId: "s1", openedAt: min(45), userAgent: HUMAN_UA }],
      auditMeaningfullyEngaged: true,
    }));
    expect(v.state).toBe("MEANINGFUL_ENGAGEMENT");
  });
  it("reply, stop and OOO pause override any opens, in that order", () => {
    const opens = [
      { sendId: "s1", openedAt: min(45), userAgent: HUMAN_UA },
      { sendId: "s1", openedAt: min(60), userAgent: HUMAN_UA },
    ];
    expect(evaluateEngagement(facts({ opens, replies: [{ classification: "not_interested", receivedAt: min(100) }] })).state).toBe("REPLIED");
    expect(evaluateEngagement(facts({ opens, stopReason: "hard bounce", replies: [{ classification: "out_of_office", receivedAt: min(100) }] })).state).toBe("STOPPED");
    expect(evaluateEngagement(facts({ opens, pausedUntil: min(10 * 24 * 60), replies: [{ classification: "out_of_office", receivedAt: min(100) }] })).state).toBe("OOO_PAUSED");
    expect(evaluateEngagement(facts({ opens, pausedUntil: min(60) })).state).toBe("MEANINGFUL_ENGAGEMENT");
  });
});

const snapshot: MismatchEvidenceSnapshot = {
  templateVersion: "competitive_mismatch_reply_v1",
  runId: "11111111-1111-4111-8111-111111111111",
  provider: "openai",
  answerCount: 64,
  modelCount: 1,
  capturedAt: "2026-08-30T00:00:00Z",
  completedAt: "2026-08-30T00:00:00Z",
  scopeCopy: "Reno buyer and seller questions",
  audiences: ["buyer", "seller"],
  prospect: {
    companyId: "22222222-2222-4222-8222-222222222222", prospectId: null, name: "Kane and Partners",
    recommendationCount: 7, productionSignalId: "p", productionSourceUrl: "https://realtrends.example",
    productionYear: 2025, productionValue: 47_200_000, productionDisplay: "$47.2M closed",
  },
  competitor: {
    companyId: "33333333-3333-4333-8333-333333333333", prospectId: null, name: "Harbor View Group",
    recommendationCount: 14, productionSignalId: "c", productionSourceUrl: "https://realtrends.example",
    productionYear: 2025, productionValue: 29_400_000, productionDisplay: "$29.4M closed",
    productionRatio: 0.62, recommendationGap: 7,
  },
  metricType: "closed_volume",
  thresholds: MISMATCH_THRESHOLDS,
};
const TAIL = ["1399 Myrtle Ave, Brooklyn, NY 11237", 'If you\'d rather not hear from us, reply "unsubscribe" and we will not contact you again.'];
const input = (distinct: number) => ({
  firstName: "Ryan", marketName: "Reno, NV", snapshot, distinctCompetitorQuestions: distinct, footerTail: TAIL,
});

describe("follow-up templates — frozen evidence, claim gate, copy linter", () => {
  it("renders every template from the frozen snapshot and passes QA", () => {
    for (const version of Object.values(FOLLOWUP_TEMPLATE_VERSIONS)) {
      const r = renderFollowup(version, input(4));
      expect(lintFollowupCopy(r.subject, r.body)).toEqual([]);
      expect(qaFollowupEvidence(version, r.body, snapshot)).toEqual([]);
      expect(r.body.startsWith("Ryan,\n")).toBe(true);
      expect(r.body).toContain("unsubscribe");
      expect(r.body).not.toContain("—");
    }
  });
  it("T2 no-engagement opens a new thread with the frozen counts; the rest reply in-thread", () => {
    const t2 = renderFollowup(FOLLOWUP_TEMPLATE_VERSIONS.t2NoEngagement, input(1));
    expect(t2.subject).toBe("Ryan - one thing I found");
    expect(t2.body).toContain("Your team: recommended in 7 of 64 answers");
    expect(t2.body).toContain("Harbor View Group: recommended in 14 of 64");
    expect(t2.body).toContain("$47.2M closed, ahead of Harbor View Group at $29.4M closed");
    expect(followupStartsNewThread(FOLLOWUP_TEMPLATE_VERSIONS.t2NoEngagement)).toBe(true);
    expect(followupStartsNewThread(FOLLOWUP_TEMPLATE_VERSIONS.t2Engaged)).toBe(false);
    expect(renderFollowup(FOLLOWUP_TEMPLATE_VERSIONS.t3Engaged, input(1)).subject).toBeNull();
  });
  it("the 'several questions' claim needs ≥ 3 distinct questions, else the side-by-side fallback", () => {
    const several = renderFollowup(FOLLOWUP_TEMPLATE_VERSIONS.t2Engaged, input(3));
    expect(several.claimVariant).toBe("several_questions");
    expect(several.body).toContain("showed up across several");
    const fallback = renderFollowup(FOLLOWUP_TEMPLATE_VERSIONS.t2Engaged, input(2));
    expect(fallback.claimVariant).toBe("side_by_side");
    expect(fallback.body).not.toContain("several");
    expect(fallback.body).toContain("your team closed more, but Harbor View Group was still recommended more often");
  });
  it("T3 no-engagement restates the frozen comparison without a denominator drift", () => {
    const r = renderFollowup(FOLLOWUP_TEMPLATE_VERSIONS.t3NoEngagement, input(1));
    expect(r.body).toContain("recommended 14 times versus 7 for your team");
    expect(qaFollowupEvidence(FOLLOWUP_TEMPLATE_VERSIONS.t3NoEngagement, r.body.replace("14 times", "13 times"), snapshot)).not.toEqual([]);
  });
  it("evidence QA blocks drifted counts, denominators and competitors", () => {
    const r = renderFollowup(FOLLOWUP_TEMPLATE_VERSIONS.t2NoEngagement, input(1));
    expect(qaFollowupEvidence(FOLLOWUP_TEMPLATE_VERSIONS.t2NoEngagement, r.body.replace("7 of 64", "8 of 64"), snapshot).map((i) => i.check)).toContain("followup_evidence");
    expect(qaFollowupEvidence(FOLLOWUP_TEMPLATE_VERSIONS.t2NoEngagement, r.body.replaceAll("of 64", "of 65"), snapshot).length).toBeGreaterThan(0);
    expect(qaFollowupEvidence(FOLLOWUP_TEMPLATE_VERSIONS.t2NoEngagement, r.body.replaceAll("Harbor View Group", "Other Team"), snapshot).length).toBeGreaterThan(0);
  });
  it("copy linter flags buzzwords, placeholders, links, legacy footer and sales moves", () => {
    const flags = (body: string): string[] => lintFollowupCopy(null, body).map((i) => i.detail);
    const base = renderFollowup(FOLLOWUP_TEMPLATE_VERSIONS.t3Engaged, input(1)).body;
    expect(flags(base.replace("AI keeps", "the LLM keeps"))).toEqual([expect.stringContaining("LLM")]);
    expect(flags(base.replace("private report", "private benchmark"))[0]).toContain("benchmark");
    expect(flags(base.replace("Ryan,", "{first_name},"))[0]).toContain("placeholder");
    expect(flags(base.replace("Want me to send it?", "See https://app.recommendedfirst.com/x"))).toHaveLength(2);
    expect(flags(base.replace("Want me to send it?", "Book a call on my Calendly."))).not.toEqual([]);
    expect(flags(base.replace("Last note", "Just following up"))).toEqual([]);
    expect(flags(base.replace("The part", "Just following up, the part"))).not.toEqual([]);
    expect(flags(base.replace("unsubscribe", "opt out"))).not.toEqual([]);
  });
  it("branch → template mapping", () => {
    expect(followupTemplateFor(2, "engaged")).toBe(FOLLOWUP_TEMPLATE_VERSIONS.t2Engaged);
    expect(followupTemplateFor(2, "no_engagement")).toBe(FOLLOWUP_TEMPLATE_VERSIONS.t2NoEngagement);
    expect(followupTemplateFor(3, "engaged")).toBe(FOLLOWUP_TEMPLATE_VERSIONS.t3Engaged);
    expect(followupTemplateFor(3, "no_engagement")).toBe(FOLLOWUP_TEMPLATE_VERSIONS.t3NoEngagement);
  });
});
