/** Spec 163 (G3) — follow-ups leave only inside the recipient-local window. */
import { describe, expect, it } from "vitest";
import { followupDispatchDecision } from "@/lib/prospects/followups";

const seq = { id: "seq-g3", timezone: "America/New_York" };
// 2026-10-27 is a Tuesday; New York is UTC-4 on that date.
const at = (iso: string) => new Date(iso);

describe("followupDispatchDecision", () => {
  it("sends when due inside the window on the slotted local day", () => {
    expect(followupDispatchDecision(seq, at("2026-10-27T13:30:00Z"), at("2026-10-27T13:40:00Z"))).toEqual({ send: true });
  });

  it("defers to the next business-day slot when the window has passed", () => {
    const d = followupDispatchDecision(seq, at("2026-10-27T13:30:00Z"), at("2026-10-27T19:00:00Z"));
    expect(d.send).toBe(false);
    if (d.send) return;
    expect(d.deferTo.toISOString().slice(0, 10)).toBe("2026-10-28");
    expect(d.deferTo.getUTCHours()).toBe(13); // 09:xx local
  });

  it("defers a touch from the previous day to today's slot when the worker boots before the window", () => {
    const d = followupDispatchDecision(seq, at("2026-10-26T13:30:00Z"), at("2026-10-27T07:00:00Z")); // 03:00 local
    expect(d.send).toBe(false);
    if (d.send) return;
    expect(d.deferTo.toISOString().slice(0, 10)).toBe("2026-10-27");
    expect(d.deferTo.getTime()).toBeGreaterThan(at("2026-10-27T13:00:00Z").getTime());
  });

  it("does not send on a weekend; defers to Monday", () => {
    const d = followupDispatchDecision(seq, at("2026-10-31T13:30:00Z"), at("2026-10-31T13:40:00Z")); // Saturday
    expect(d.send).toBe(false);
    if (d.send) return;
    expect(d.deferTo.toISOString().slice(0, 10)).toBe("2026-11-02");
  });

  it("crosses the 25-hour DST-end day (regression: nextMorningSlot looped on 2026-11-01)", () => {
    const d = followupDispatchDecision(seq, at("2026-10-30T13:30:00Z"), at("2026-11-01T12:00:00Z"));
    expect(d.send).toBe(false);
    if (d.send) return;
    expect(d.deferTo.toISOString().slice(0, 13)).toBe("2026-11-02T14"); // 09:xx EST
  });
});
