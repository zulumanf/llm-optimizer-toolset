import { describe, expect, it } from "vitest";
import { groupSlotsByDay, walkthroughSlots, WALKTHROUGH_DAYS, WALKTHROUGH_SLOT_HOURS } from "@/lib/prospects/walkthrough";

describe("walkthrough slots — plain, local, business days, ≥ 20h ahead", () => {
  const NY = "America/New_York";
  it("offers five business days of local-hour slots and skips the weekend and Labor Day", () => {
    // Thursday Sep 3, 2026 16:00 ET.
    const slots = walkthroughSlots(new Date("2026-09-03T20:00:00Z"), NY);
    const days = groupSlotsByDay(slots);
    expect(days.length).toBe(WALKTHROUGH_DAYS);
    expect(days.map((d) => d.dayLabel)).toEqual([
      "Friday, September 4", "Tuesday, September 8", "Wednesday, September 9", "Thursday, September 10", "Friday, September 11",
    ]);
    // Thursday 16:00 + 20h = Friday noon → Friday's 9 and 11 are gone; 2 and 4 remain.
    expect(days[0]!.slots.map((s) => s.timeLabel)).toEqual(["2:00 PM EDT", "4:00 PM EDT"]);
    expect(days[1]!.slots.length).toBe(WALKTHROUGH_SLOT_HOURS.length);
    expect(days[1]!.slots[0]!.at).toBe("2026-09-08T13:00:00.000Z");
  });
  it("uses the prospect's zone", () => {
    const slots = walkthroughSlots(new Date("2026-09-03T20:00:00Z"), "America/Los_Angeles");
    expect(slots[0]!.timeLabel).toContain("PDT");
    expect(slots.find((s) => s.at === "2026-09-08T16:00:00.000Z")?.timeLabel).toBe("9:00 AM PDT");
  });
});
