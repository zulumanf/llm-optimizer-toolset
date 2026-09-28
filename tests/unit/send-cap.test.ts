import { describe, expect, it } from "vitest";
import { DAILY_SEND_QUOTA, GMAIL_DAILY_SEND_CAP } from "@/lib/prospects/constants";
import { quotaStreak, type MomentumDay } from "@/lib/prospects/momentum";
import {
  SEND_CAP_RAMP,
  SEND_CAP_RAMP_VERSION,
  dailySendQuota,
  gmailDailySendCap,
  sendCapStep,
  sendCapStepForDay,
} from "@/lib/prospects/send-cap";

describe("send cap ramp (spec 143)", () => {
  it("is versioned and starts from the base policy constants", () => {
    expect(SEND_CAP_RAMP_VERSION).toBe("send-cap-ramp-v1+deterministic");
    expect(SEND_CAP_RAMP[0]).toEqual({ effectiveFrom: null, transportCap: GMAIL_DAILY_SEND_CAP, touch1Quota: DAILY_SEND_QUOTA });
  });

  it("returns the step in force on each date", () => {
    const at = (iso: string) => new Date(iso);
    expect([gmailDailySendCap(at("2026-09-29T16:00:00Z")), dailySendQuota(at("2026-09-29T16:00:00Z"))]).toEqual([25, 15]);
    expect([gmailDailySendCap(at("2026-09-30T16:00:00Z")), dailySendQuota(at("2026-09-30T16:00:00Z"))]).toEqual([35, 30]);
    expect([gmailDailySendCap(at("2026-10-06T16:00:00Z")), dailySendQuota(at("2026-10-06T16:00:00Z"))]).toEqual([35, 30]);
    expect([gmailDailySendCap(at("2026-10-07T16:00:00Z")), dailySendQuota(at("2026-10-07T16:00:00Z"))]).toEqual([45, 40]);
    expect([gmailDailySendCap(at("2026-10-14T16:00:00Z")), dailySendQuota(at("2026-10-14T16:00:00Z"))]).toEqual([50, 45]);
    expect(gmailDailySendCap(at("2027-01-05T16:00:00Z"))).toBe(50);
  });

  it("changes step at operator-timezone midnight, not UTC midnight", () => {
    // 2026-09-30T02:00Z is still 22:00 on 9/29 in New York.
    expect(sendCapStep(new Date("2026-09-30T02:00:00Z")).transportCap).toBe(25);
    // 2026-09-30T04:00Z is 00:00 on 9/30 in New York (EDT, UTC-4).
    expect(sendCapStep(new Date("2026-09-30T04:00:00Z")).transportCap).toBe(35);
  });

  it("dates before the first step keep the base step", () => {
    expect(sendCapStep(new Date("2026-08-25T16:00:00Z"))).toEqual(SEND_CAP_RAMP[0]);
    expect(sendCapStepForDay("2026-08-25").touch1Quota).toBe(DAILY_SEND_QUOTA);
  });

  it("every step keeps the quota under the cap, and the schedule never decreases", () => {
    for (let i = 0; i < SEND_CAP_RAMP.length; i += 1) {
      const step = SEND_CAP_RAMP[i]!;
      expect(step.touch1Quota).toBeLessThan(step.transportCap);
      if (i === 0) continue;
      const prev = SEND_CAP_RAMP[i - 1]!;
      expect(step.effectiveFrom).not.toBeNull();
      if (prev.effectiveFrom !== null) expect(step.effectiveFrom! > prev.effectiveFrom).toBe(true);
      expect(step.transportCap).toBeGreaterThanOrEqual(prev.transportCap);
      expect(step.touch1Quota).toBeGreaterThanOrEqual(prev.touch1Quota);
    }
  });

  it("capacity for a period spanning a step is the sum of daily caps", () => {
    const days = ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01"];
    expect(days.reduce((sum, d) => sum + sendCapStepForDay(d).transportCap, 0)).toBe(25 + 25 + 35 + 35);
  });

  it("a streak judges each day by the quota in force that day", () => {
    const day = (key: string, firstTouch: number, isToday = false): MomentumDay => ({ day: key, firstTouch, followUps: 0, refused: 0, replies: 0, isBusinessDay: true, isToday });
    const days = [day("2026-09-28", 17), day("2026-09-29", 18), day("2026-09-30", 30), day("2026-10-01", 31, true)];
    expect(quotaStreak(days, (d) => sendCapStepForDay(d).touch1Quota)).toBe(4);
    // Judged by today's quota alone, the pre-ramp days would wrongly break it.
    expect(quotaStreak(days, 30)).toBe(2);
  });
});
