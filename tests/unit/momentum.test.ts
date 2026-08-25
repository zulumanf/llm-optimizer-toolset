/**
 * Spec 119 — momentum scoreboard pure derivations: calendar fill, quota
 * streak (business days only, today never breaks), touch depth, and median
 * time to first reply. Pure fixtures; no database.
 */
import { describe, expect, it } from "vitest";
import {
  fillDailySeries,
  medianHoursToFirstReply,
  quotaStreak,
  touchDepthDistribution,
  type MomentumDay,
} from "@/lib/prospects/momentum";
import { deriveIntent, type ProspectBehaviorFacts, type SendFact } from "@/lib/prospects/intent";

const NOW = new Date("2026-08-28T12:00:00Z"); // Friday, 8 AM ET
const T1 = new Date("2026-08-18T13:00:00Z"); // Tue 9 AM ET

const send = (sentAt: Date, touch: number): SendFact => ({ sentAt, touch, subject: "S", draftChannel: touch === 1 ? "email" : "followup_email", opens: 0, bounced: false });
let seq = 0;
const facts = (over: Partial<ProspectBehaviorFacts>): ProspectBehaviorFacts => ({
  prospectId: `p${++seq}`, businessName: `P${seq}`, launchId: "L1", launchName: "Jersey City", qualityScore: 75, stage: "contacted", visitedStages: ["contacted"],
  sentAts: [T1], sends: [send(T1, 1)], prospectType: "team", repliedAt: null, meetingAt: null, opens: 0, views: [], hasEmail: true, auditPublished: true, unqualifiedViews: 0, ...over,
});
const P = (over: Partial<ProspectBehaviorFacts> = {}) => deriveIntent(facts(over), NOW);

const D = (day: string, sends: number, over: Partial<MomentumDay> = {}): MomentumDay => ({
  day, firstTouch: sends, followUps: 0, refused: 0, replies: 0, isBusinessDay: true, isToday: false, ...over,
});

describe("fillDailySeries", () => {
  it("fills every operator day in the window, flags today and weekends, and keeps supplied rows", () => {
    const days = fillDailySeries([{ day: "2026-08-28", firstTouch: 5, followUps: 2, refused: 1, replies: 1 }], NOW);
    expect(days).toHaveLength(30);
    expect(days[0]!.day).toBe("2026-07-30");
    const today = days[days.length - 1]!;
    expect(today).toMatchObject({ day: "2026-08-28", firstTouch: 5, followUps: 2, refused: 1, replies: 1, isToday: true, isBusinessDay: true });
    const sunday = days.find((d) => d.day === "2026-08-23")!;
    expect(sunday).toMatchObject({ firstTouch: 0, followUps: 0, isBusinessDay: false, isToday: false });
    expect(days.filter((d) => d.isToday)).toHaveLength(1);
  });
});

describe("quotaStreak", () => {
  const Q = 15;
  it("counts consecutive business days at quota", () => {
    expect(quotaStreak([D("2026-08-26", 15), D("2026-08-27", 15), D("2026-08-28", 15, { isToday: true })], Q)).toBe(3);
  });
  it("an in-progress today below quota is skipped, not a break", () => {
    expect(quotaStreak([D("2026-08-26", 15), D("2026-08-27", 15), D("2026-08-28", 3, { isToday: true })], Q)).toBe(2);
  });
  it("weekends neither count nor break", () => {
    expect(
      quotaStreak(
        [D("2026-08-21", 15), D("2026-08-22", 0, { isBusinessDay: false }), D("2026-08-23", 0, { isBusinessDay: false }), D("2026-08-24", 15, { isToday: true })],
        Q
      )
    ).toBe(2);
  });
  it("a sub-quota past business day ends the streak; follow-ups count toward quota", () => {
    expect(quotaStreak([D("2026-08-25", 15), D("2026-08-26", 2), D("2026-08-27", 10, { followUps: 5 }), D("2026-08-28", 15, { isToday: true })], Q)).toBe(2);
    expect(quotaStreak([], Q)).toBe(0);
  });
});

describe("touchDepthDistribution", () => {
  it("buckets contacted prospects by max touch and counts the stalled-at-one backlog", () => {
    const t2 = new Date("2026-08-21T13:00:00Z");
    const t3 = new Date("2026-08-25T13:00:00Z");
    const items = [
      P(), // 1 touch, silent since Aug 18 → follow-up overdue → stalled
      P({ repliedAt: new Date(T1.getTime() + 3_600_000), visitedStages: ["contacted", "replied"], stage: "replied" }), // 1 touch, replied — not stalled
      P({ sentAts: [T1, t2], sends: [send(T1, 1), send(t2, 2)] }),
      P({ sentAts: [T1, t2, t3], sends: [send(T1, 1), send(t2, 2), send(t3, 3)] }),
      P({ sentAts: [], sends: [] }), // never contacted — excluded entirely
    ];
    const d = touchDepthDistribution(items);
    expect(d.contacted).toBe(4);
    expect(d.rows).toEqual([
      { depth: "1 touch", prospects: 2, replied: 1 },
      { depth: "2 touches", prospects: 1, replied: 0 },
      { depth: "3+ touches", prospects: 1, replied: 0 },
    ]);
    expect(d.stalledAtOne).toBe(1);
  });
});

describe("medianHoursToFirstReply", () => {
  const at = (h: number) => new Date(T1.getTime() + h * 3_600_000);
  it("returns the median over replied prospects, odd and even", () => {
    expect(medianHoursToFirstReply([P({ repliedAt: at(10) }), P({ repliedAt: at(20) }), P({ repliedAt: at(90) })])).toEqual({ hours: 20, n: 3 });
    expect(medianHoursToFirstReply([P({ repliedAt: at(10) }), P({ repliedAt: at(20) })])).toEqual({ hours: 15, n: 2 });
  });
  it("ignores prospects without a reply or whose reply predates the first send", () => {
    expect(medianHoursToFirstReply([P(), P({ repliedAt: at(-5) })])).toEqual({ hours: null, n: 0 });
  });
});
