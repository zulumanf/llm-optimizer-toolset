/**
 * Spec 085: the cadence promise is arithmetic — next Monday, UTC.
 */
import { describe, expect, it } from "vitest";
import { nextMondayIso } from "@/lib/portal/service";

describe("nextMondayIso", () => {
  it("advances to the coming Monday from every weekday", () => {
    expect(nextMondayIso(new Date("2026-08-18T12:00:00Z"))).toBe("2026-08-24"); // Tue
    expect(nextMondayIso(new Date("2026-08-21T12:00:00Z"))).toBe("2026-08-24"); // Fri
    expect(nextMondayIso(new Date("2026-08-23T12:00:00Z"))).toBe("2026-08-24"); // Sun
  });

  it("a Monday promises the NEXT Monday — the day's run already fired", () => {
    expect(nextMondayIso(new Date("2026-08-17T12:00:00Z"))).toBe("2026-08-24");
  });
});
