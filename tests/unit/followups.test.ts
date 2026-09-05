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
  CATEGORY_LINE_PREFIX,
  followupStartsNewThread,
  followupTemplateFor,
  lintFollowupCopy,
  qaFollowupEvidence,
  renderFollowup,
  type FollowupQaContext,
  type FollowupRenderInput,
} from "@/lib/prospects/followup-templates";
import { sequenceExpired, sequenceExpiresAt } from "@/lib/prospects/followups";
import { classifyReplyText, stripQuotedReply } from "@/lib/prospects/reply-classify";
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
const input = (distinct: number, over: Partial<FollowupRenderInput> = {}): FollowupRenderInput => ({
  firstName: "Ryan", marketName: "Reno, NV", snapshot, distinctCompetitorQuestions: distinct, footerTail: TAIL,
  entityType: "team", reportReady: false, categoryLine: null, ...over,
});
const ctx = (distinct: number, over: Partial<FollowupQaContext> = {}): FollowupQaContext => ({
  entityType: "team", reportReady: false, distinctCompetitorQuestions: distinct, categoryLine: null, ...over,
});
const ALL = Object.values(FOLLOWUP_TEMPLATE_VERSIONS);
const { t2NoEngagement, t2Engaged, t3Engaged, t3NoEngagement } = FOLLOWUP_TEMPLATE_VERSIONS;

describe("follow-up templates v2 — frozen evidence, entity wording, claim gates, copy linter", () => {
  it("renders every template for teams and agents from the frozen snapshot and passes QA", () => {
    for (const version of ALL) {
      for (const entityType of ["team", "individual"] as const) {
        const r = renderFollowup(version, input(4, { entityType }));
        expect(lintFollowupCopy(r.subject, r.body)).toEqual([]);
        expect(qaFollowupEvidence(version, r.body, snapshot, ctx(4, { entityType }))).toEqual([]);
        expect(r.body.startsWith("Ryan,\n")).toBe(true);
        expect(r.body).toContain("unsubscribe");
        expect(r.body).not.toMatch(/[—–]/);
        expect(r.body).not.toContain("private report");
        expect(r.body).not.toMatch(/ChatGPT|AEO|GEO|LLM/);
        expect(r.body.split("\n--\n")[0]!.split(/\s+/).length).toBeLessThanOrEqual(120);
        expect((r.body.split("\n--\n")[0]!.match(/\?/g) ?? []).length).toBeLessThanOrEqual(1);
        expect(r.body).toContain(r.cta);
      }
    }
  });
  it("a team gets 'your team'; an individual agent gets 'you'", () => {
    const team = renderFollowup(t2NoEngagement, input(1, { entityType: "team" })).body;
    expect(team).toContain("RealTrends has your team at $47.2M closed versus $29.4M closed for Harbor View Group.");
    expect(team).toContain("Your team: recommended in 7 of 64 answers");
    const agent = renderFollowup(t2NoEngagement, input(1, { entityType: "individual" })).body;
    expect(agent).toContain("RealTrends has you at $47.2M closed versus $29.4M closed for Harbor View Group.");
    expect(agent).toContain("You: recommended in 7 of 64 answers");
    expect(agent).not.toMatch(/your team/i);
    expect(renderFollowup(t3Engaged, input(1, { entityType: "individual" })).body).toContain("RealTrends has you ahead of Harbor View Group");
    // Wrong wording is a QA failure either way; unknown entity type fails closed.
    expect(qaFollowupEvidence(t2NoEngagement, team, snapshot, ctx(1, { entityType: "individual" })).map((i) => i.check)).toContain("followup_entity");
    expect(qaFollowupEvidence(t2NoEngagement, agent, snapshot, ctx(1, { entityType: "team" })).map((i) => i.check)).toContain("followup_entity");
    const unknown = renderFollowup(t2NoEngagement, input(1, { entityType: null }));
    expect(lintFollowupCopy(unknown.subject, unknown.body).some((i) => i.detail.includes("placeholder"))).toBe(true);
    expect(qaFollowupEvidence(t2NoEngagement, unknown.body, snapshot, ctx(1, { entityType: null })).map((i) => i.check)).toContain("followup_entity");
  });
  it("T2 no-engagement opens a new thread with the frozen counts; the rest reply in-thread", () => {
    const t2 = renderFollowup(t2NoEngagement, input(1));
    expect(t2.subject).toBe("Ryan - one thing I found");
    expect(t2.body).toContain("One more thing on Reno.");
    expect(t2.body).toContain("Harbor View Group: recommended in 14 of 64");
    expect(t2.cta).toBe("Want me to send them?");
    expect(followupStartsNewThread(t2NoEngagement)).toBe(true);
    expect(followupStartsNewThread(t2Engaged)).toBe(false);
    expect(followupStartsNewThread(t3Engaged)).toBe(false);
    expect(followupStartsNewThread(t3NoEngagement)).toBe(false);
    expect(renderFollowup(t3Engaged, input(1)).subject).toBeNull();
  });
  it("the distinct-questions claim needs ≥ 3 and the exact frozen count, else the side-by-side fallback", () => {
    const several = renderFollowup(t2Engaged, input(9));
    expect(several.claimVariant).toBe("distinct_questions");
    expect(several.body).toContain("Harbor View Group came up across 9 different questions in the same Reno test.");
    expect(qaFollowupEvidence(t2Engaged, several.body, snapshot, ctx(9))).toEqual([]);
    expect(qaFollowupEvidence(t2Engaged, several.body, snapshot, ctx(8)).map((i) => i.check)).toContain("followup_claim");
    const fallback = renderFollowup(t2Engaged, input(2));
    expect(fallback.claimVariant).toBe("side_by_side");
    expect(fallback.body).not.toContain("different questions");
    expect(fallback.body).toContain("RealTrends has your team at $47.2M closed versus $29.4M closed for Harbor View Group, but the recommendation results went the other way.");
    expect(fallback.body).toContain("I already have the exact questions and answers pulled together.");
    // A hand-edited claim of 3 over a frozen count of 2 fails.
    const forged = fallback.body.replace("One more thing I noticed.", "Harbor View Group came up across 3 different questions in the same Reno test.");
    expect(qaFollowupEvidence(t2Engaged, forged, snapshot, ctx(2)).map((i) => i.check)).toContain("followup_claim");
  });
  it("never claims a report exists unless one is finished for this evidence", () => {
    for (const version of ALL) {
      const plain = renderFollowup(version, input(4));
      expect(plain.body).toContain("exact questions and answers pulled together");
      const ready = renderFollowup(version, input(4, { reportReady: true }));
      expect(ready.body).toContain("I have the private report ready");
      expect(ready.body).toMatch(/send it/);
      expect(qaFollowupEvidence(version, ready.body, snapshot, ctx(4, { reportReady: true }))).toEqual([]);
      expect(qaFollowupEvidence(version, ready.body, snapshot, ctx(4, { reportReady: false })).map((i) => i.check)).toContain("followup_report");
    }
  });
  it("Touch 3 carries the story: why you, last note, one ask, optional supported category line", () => {
    const eng = renderFollowup(t3Engaged, input(4));
    expect(eng.body).toContain("Last note from me on this.");
    expect(eng.body).toContain("The only reason I reached out is that the numbers looked backwards to me.");
    expect(eng.body).toContain("Just say yes and I'll send them.");
    expect(eng.body).not.toContain(CATEGORY_LINE_PREFIX);
    const line = `${CATEGORY_LINE_PREFIX}seller questions.`;
    const withLine = renderFollowup(t3Engaged, input(4, { categoryLine: line }));
    expect(withLine.body).toContain(`${line}\n\nThat's what made me take a closer look.`);
    expect(qaFollowupEvidence(t3Engaged, withLine.body, snapshot, ctx(4, { categoryLine: line }))).toEqual([]);
    expect(qaFollowupEvidence(t3Engaged, withLine.body, snapshot, ctx(4, { categoryLine: null })).map((i) => i.check)).toContain("followup_claim");
    const no = renderFollowup(t3NoEngagement, input(1));
    expect(no.body).toContain("The only reason I emailed you is that RealTrends has your team at $47.2M closed versus $29.4M closed for Harbor View Group, but the recommendation results went the other way.");
    expect(no.body).toContain("If you want to see them, just say yes and I'll send them.");
  });
  it("evidence QA blocks drifted counts, denominators and competitors", () => {
    const r = renderFollowup(t2NoEngagement, input(1));
    const qa = (body: string) => qaFollowupEvidence(t2NoEngagement, body, snapshot, ctx(1));
    expect(qa(r.body.replace("7 of 64", "8 of 64")).map((i) => i.check)).toContain("followup_evidence");
    expect(qa(r.body.replaceAll("of 64", "of 65")).length).toBeGreaterThan(0);
    expect(qa(r.body.replaceAll("Harbor View Group", "Other Team")).length).toBeGreaterThan(0);
    expect(qa(r.body.replace("$47.2M", "$48.2M")).length).toBeGreaterThan(0);
  });
  it("copy linter flags dashes, jargon, ChatGPT, links, placeholders, filler, sales moves, length and double asks", () => {
    const flags = (body: string): string[] => lintFollowupCopy(null, body).map((i) => i.detail);
    const base = renderFollowup(t3Engaged, input(1)).body;
    expect(flags(base)).toEqual([]);
    expect(flags(base.replace("Last note", "Last note — really"))).toEqual([expect.stringContaining("em dash")]);
    expect(flags(base.replace("Last note", "Last note – really"))).toEqual([expect.stringContaining("en dash")]);
    expect(flags(base.replace("questions I tested", "prompts I tested")).join()).toContain("prompts");
    expect(flags(base.replace("questions I tested", "questions I tested in ChatGPT")).join()).toContain("ChatGPT");
    expect(flags(base.replace("questions I tested", "LLM questions I tested")).join()).toContain("LLM");
    expect(flags(base.replace("Ryan,", "{first_name},"))[0]).toContain("placeholder");
    expect(flags(base.replace("Just say yes and I'll send them.", "See https://app.recommendedfirst.com/x"))).toHaveLength(2);
    expect(flags(base.replace("Just say yes and I'll send them.", "Book 15 minutes on my Calendly."))).not.toEqual([]);
    expect(flags(base.replace("Last note from me on this.", "Just following up on this."))).not.toEqual([]);
    expect(flags(base.replace("Last note from me on this.", "Circling back, checking in, touching base."))).not.toEqual([]);
    expect(flags(base.replace("Last note from me on this.", "This is your last chance for market exclusivity pricing."))).not.toEqual([]);
    expect(flags(base.replace("Just say yes and I'll send them.", "Want them? Or a call?")).join()).toContain("more than one ask");
    expect(flags(base.replace("Last note from me on this.", Array(130).fill("word").join(" "))).join()).toContain("words before the signature");
    expect(flags(base.replace("unsubscribe", "opt out"))).not.toEqual([]);
    expect(flags(base.replace("\n--\n", "\n--\n--\n"))).not.toEqual([]);
  });
  it("branch → template mapping", () => {
    expect(followupTemplateFor(2, "engaged")).toBe(t2Engaged);
    expect(followupTemplateFor(2, "no_engagement")).toBe(t2NoEngagement);
    expect(followupTemplateFor(3, "engaged")).toBe(t3Engaged);
    expect(followupTemplateFor(3, "no_engagement")).toBe(t3NoEngagement);
    expect(ALL.every((v) => v.endsWith("_v2"))).toBe(true);
  });
});

describe("sequence expiry — 21 calendar days from the successful Touch 1", () => {
  it("expires exactly 21 days after the actual send, regardless of deferrals", () => {
    const t1 = new Date("2026-09-01T13:07:00Z");
    expect(sequenceExpiresAt(t1).toISOString()).toBe("2026-09-22T13:07:00.000Z");
    expect(sequenceExpired(t1, new Date("2026-09-22T13:06:00Z"))).toBe(false);
    expect(sequenceExpired(t1, new Date("2026-09-22T13:08:00Z"))).toBe(true);
  });
});

describe("reply text — our own quoted footer and unreadable bodies never classify", () => {
  const OUR_T1 = [
    "On Thu, Sep 3, 2026 at 2:54 PM Francisco <f@recommendedfirst.com> wrote:",
    "> Steve,", "> ...", "> --", "> Francisco Zuluaga · Recommended First",
    '> If you\'d rather not hear from us, reply "unsubscribe" and we will not contact you again.',
  ];
  it("a one-word human reply above the quote is what gets classified", () => {
    const text = stripQuotedReply(["Yes", "", ...OUR_T1].join("\n"));
    expect(text).toBe("Yes");
    expect(classifyReplyText(text)).toBe("positive_interest");
  });
  it("an all-quoted or redacted body yields '' → unclear, never unsubscribe", () => {
    expect(stripQuotedReply(OUR_T1.join("\n"))).toBe("");
    expect(classifyReplyText(stripQuotedReply(OUR_T1.join("\n")))).toBe("unclear");
    expect(stripQuotedReply("[redacted]")).toBe("");
    // Client that quotes without ">" markers or an "On … wrote:" line.
    const flat = ["", "--", "Francisco Zuluaga · Recommended First", "www.RecommendedFirst.com", 'If you\'d rather not hear from us, reply "unsubscribe" and we will not contact you again.'].join("\n");
    expect(classifyReplyText(stripQuotedReply(flat))).toBe("unclear");
    expect(classifyReplyText(stripQuotedReply(`Sure, send it.${flat}`))).toBe("positive_interest");
  });
  it("a human who actually opts out still classifies as unsubscribe", () => {
    expect(classifyReplyText(stripQuotedReply(["Please unsubscribe me.", ...OUR_T1].join("\n")))).toBe("unsubscribe");
  });
});
