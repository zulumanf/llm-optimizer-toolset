import { describe, expect, it } from "vitest";
import { campaignDigestDue, classifySend, type SendRow } from "@/lib/prospects/campaign-ledger";
import { MISMATCH_TEMPLATE_VERSION, REPORT_DELIVERY_TEMPLATE_VERSION } from "@/lib/prospects/constants";

const base: SendRow = { sentAt: new Date(), prospectId: "p", providerMessageId: "m", touch: null, promptVersion: null, replyTo: null, sequenceId: null };

describe("campaign digest windows (operator-local, America/New_York)", () => {
  it("is due for nothing before the morning window", () => {
    // 2026-09-08 07:00 ET = 11:00Z
    const d = campaignDigestDue(new Date("2026-09-08T11:00:00Z"));
    expect(d).toEqual({ preflight: false, ledger: false, weekly: false, day: "2026-09-08" });
  });
  it("is due for the pre-flight after 07:40 ET and the ledger after 18:10 ET", () => {
    expect(campaignDigestDue(new Date("2026-09-08T11:41:00Z")).preflight).toBe(true);
    expect(campaignDigestDue(new Date("2026-09-08T22:09:00Z")).ledger).toBe(false);
    expect(campaignDigestDue(new Date("2026-09-08T22:11:00Z")).ledger).toBe(true);
  });
  it("is due for the weekly report only on Monday evenings", () => {
    expect(campaignDigestDue(new Date("2026-09-14T22:20:00Z")).weekly).toBe(true);
    expect(campaignDigestDue(new Date("2026-09-15T22:20:00Z")).weekly).toBe(false);
    expect(campaignDigestDue(new Date("2026-09-14T15:00:00Z")).weekly).toBe(false);
  });
  it("keys the day by the operator's calendar, not UTC", () => {
    // 2026-09-08 23:30 ET is already 2026-09-09 in UTC.
    expect(campaignDigestDue(new Date("2026-09-09T03:30:00Z")).day).toBe("2026-09-08");
  });
});

describe("send classification", () => {
  it("separates touches, founder replies and other outbound", () => {
    expect(classifySend({ ...base, promptVersion: MISMATCH_TEMPLATE_VERSION })).toBe("T1");
    expect(classifySend({ ...base, sequenceId: "s", touch: 2, promptVersion: "competitive_mismatch_t2_no_engagement_v2" })).toBe("T2");
    expect(classifySend({ ...base, sequenceId: "s", touch: 3, promptVersion: "competitive_mismatch_t3_engaged_v2" })).toBe("T3");
    expect(classifySend({ ...base, replyTo: "r" })).toBe("FOUNDER");
    expect(classifySend({ ...base, promptVersion: REPORT_DELIVERY_TEMPLATE_VERSION })).toBe("FOUNDER");
    expect(classifySend({ ...base, promptVersion: "reply-first-email-v1" })).toBe("OTHER");
  });
  it("never counts a reply-to draft as a campaign touch even inside a sequence", () => {
    expect(classifySend({ ...base, sequenceId: "s", touch: 2, replyTo: "r" })).toBe("FOUNDER");
  });
});
