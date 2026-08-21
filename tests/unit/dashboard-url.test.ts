/** Spec 100: cockpit filters compose — one click never resets the others. */
import { describe, expect, it } from "vitest";
import { dashboardHref } from "@/lib/prospects/dashboard-url";

describe("dashboardHref", () => {
  it("merges a change into the current state", () => {
    const href = dashboardHref({ launch: "L1", window: "7d", intent: "high" }, { activity: "repeat" });
    const q = new URL(href, "http://x").searchParams;
    expect(q.get("launch")).toBe("L1");
    expect(q.get("window")).toBe("7d");
    expect(q.get("intent")).toBe("high");
    expect(q.get("activity")).toBe("repeat");
  });
  it("clears only the patched key when undefined, and emits a bare path when empty", () => {
    expect(dashboardHref({ launch: "L1", sales: "replied" }, { sales: undefined })).toBe("/prospects/dashboard?launch=L1");
    expect(dashboardHref({}, {})).toBe("/prospects/dashboard");
  });
  it("ignores unknown keys so nothing foreign can be smuggled into links", () => {
    expect(dashboardHref({ launch: "L1" }, { foo: "bar" } as never)).toBe("/prospects/dashboard?launch=L1");
  });
});

describe("active cohort + follow-up eligibility (spec 100)", () => {
  it("the most recently contacted launch is the default cohort; none sent → null", async () => {
    const { pickActiveLaunch } = await import("@/lib/prospects/dashboard");
    const L = (id: string, sent: string | null) => ({ id, name: id, prospectCount: 5, contactedCount: sent ? 3 : 0, lastSentAt: sent ? new Date(sent) : null });
    expect(pickActiveLaunch([L("old", "2026-08-01"), L("new", "2026-08-20"), L("never", null)])).toBe("new");
    expect(pickActiveLaunch([L("never", null)])).toBeNull();
  });
  it("followUpDueAt lands on the business-day cadence and agrees with isFollowUpDue", async () => {
    const { followUpDueAt, isFollowUpDue, summarizeEngagement, salesFacts } = await import("@/lib/prospects/intent");
    const sentThu = new Date("2026-08-20T15:00:00Z"); // Thursday
    const facts = { prospectId: "p", businessName: "x", launchId: "l", launchName: "L", qualityScore: 50, stage: "contacted" as const, visitedStages: [], sentAts: [sentThu], sends: [], prospectType: null, repliedAt: null, meetingAt: null, opens: 0, views: [], hasEmail: true, auditPublished: true, unqualifiedViews: 0 };
    const s = salesFacts(facts);
    const e = summarizeEngagement([], s.firstSentAt);
    const due = followUpDueAt(e, s)!;
    expect(due.getUTCDay()).not.toBe(0);
    expect(due.getUTCDay()).not.toBe(6);
    expect(isFollowUpDue(e, s, new Date(due.getTime() - 60_000))).toBe(false);
    expect(isFollowUpDue(e, s, due)).toBe(true);
    expect(followUpDueAt(e, { ...s, replied: true })).toBeNull();
  });
});
