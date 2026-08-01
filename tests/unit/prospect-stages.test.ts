/** Unit tests for pipeline transition rules (spec 032). */
import { describe, expect, it } from "vitest";
import { atOrPast, validateTransition } from "@/lib/prospects/stages";

describe("atOrPast", () => {
  it("orders the ladder", () => {
    expect(atOrPast("contacted", "outreach_ready")).toBe(true);
    expect(atOrPast("qualified", "outreach_ready")).toBe(false);
    expect(atOrPast("outreach_ready", "outreach_ready")).toBe(true);
  });
  it("keeps exit stages off the ladder", () => {
    expect(atOrPast("closed_lost", "outreach_ready")).toBe(false);
    expect(atOrPast("conflict_blocked", "identified")).toBe(false);
  });
});

describe("validateTransition", () => {
  it("rejects a no-op transition", () => {
    const v = validateTransition({
      fromStage: "identified",
      toStage: "identified",
      conflictStatus: "unchecked",
      doNotContact: false,
    });
    expect(v.allowed).toBe(false);
  });

  it("allows early-ladder moves without a conflict check", () => {
    const v = validateTransition({
      fromStage: "identified",
      toStage: "qualified",
      conflictStatus: "unchecked",
      doNotContact: false,
    });
    expect(v).toEqual({ allowed: true, requiresConflictCheck: false });
  });

  it("requires a fresh conflict check when crossing the gate", () => {
    const v = validateTransition({
      fromStage: "qualified",
      toStage: "outreach_ready",
      conflictStatus: "unchecked",
      doNotContact: false,
    });
    expect(v).toEqual({ allowed: true, requiresConflictCheck: true });
  });

  it("blocks progression past the gate on a recorded conflict", () => {
    const v = validateTransition({
      fromStage: "contacted",
      toStage: "replied",
      conflictStatus: "direct",
      doNotContact: false,
    });
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.overridable).toBe(true);
  });

  it("lets a standing admin override progress without a re-check", () => {
    const v = validateTransition({
      fromStage: "qualified",
      toStage: "outreach_ready",
      conflictStatus: "override",
      doNotContact: false,
    });
    expect(v).toEqual({ allowed: true, requiresConflictCheck: false });
  });

  it("closes contact stages to do-not-contact prospects, without an override path", () => {
    const v = validateTransition({
      fromStage: "outreach_ready",
      toStage: "contacted",
      conflictStatus: "clear",
      doNotContact: true,
    });
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.overridable).toBe(false);
  });

  it("allows exits (closed_lost / waitlisted) regardless of conflict state", () => {
    const v = validateTransition({
      fromStage: "contacted",
      toStage: "closed_lost",
      conflictStatus: "direct",
      doNotContact: false,
    });
    expect(v.allowed).toBe(true);
  });
});
