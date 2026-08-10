/**
 * Spec 053: the fleet grouping math is pure and known-answer tested — a
 * provider change across N clients must become ONE signal, and noise must
 * never become one at all.
 */
import { describe, expect, it } from "vitest";
import {
  groupFleetMovements,
  FLEET_DELTA,
  FLEET_MIN_PROJECTS,
  type ProjectDelta,
} from "@/lib/drift/detect";

const row = (
  projectId: string,
  delta: number,
  over: Partial<ProjectDelta> = {}
): ProjectDelta => ({
  projectId,
  projectName: `P-${projectId}`,
  provider: "openai",
  metric: "mention_rate",
  delta,
  ...over,
});

describe("groupFleetMovements", () => {
  it("three of four projects dropping together is one signal naming all three", () => {
    const signals = groupFleetMovements(
      [row("a", -0.15), row("b", -0.12), row("c", -0.2), row("d", 0.02)],
      4
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      provider: "openai",
      metric: "mention_rate",
      direction: "down",
    });
    expect(signals[0]!.affected.map((a) => a.projectId).sort()).toEqual(["a", "b", "c"]);
    expect(signals[0]!.magnitude).toBeCloseTo((0.15 + 0.12 + 0.2) / 3, 3);
  });

  it("two projects moving is below the floor — no signal", () => {
    expect(groupFleetMovements([row("a", -0.3), row("b", -0.3)], 4)).toHaveLength(0);
    expect(FLEET_MIN_PROJECTS).toBe(3);
  });

  it("three movers out of ten is below the share floor — no signal", () => {
    const signals = groupFleetMovements(
      [row("a", -0.15), row("b", -0.12), row("c", -0.2)],
      10
    );
    expect(signals).toHaveLength(0);
  });

  it("sub-threshold deltas never count as movement", () => {
    const signals = groupFleetMovements(
      [row("a", -0.09), row("b", -0.09), row("c", -0.09)],
      3
    );
    expect(signals).toHaveLength(0);
    expect(FLEET_DELTA).toBe(0.1);
  });

  it("opposite directions split into separate buckets, not one washed-out mean", () => {
    const signals = groupFleetMovements(
      [
        row("a", -0.2),
        row("b", -0.2),
        row("c", -0.2),
        row("d", 0.2),
        row("e", 0.2),
        row("f", 0.2),
      ],
      6
    );
    expect(signals).toHaveLength(2);
    expect(new Set(signals.map((s) => s.direction))).toEqual(new Set(["up", "down"]));
  });

  it("different providers are different fingerprints", () => {
    const signals = groupFleetMovements(
      [
        row("a", -0.2),
        row("b", -0.2),
        row("c", -0.2),
        row("a", -0.2, { provider: "google" }),
        row("b", -0.2, { provider: "google" }),
        row("c", -0.2, { provider: "google" }),
      ],
      3
    );
    expect(signals).toHaveLength(2);
    expect(new Set(signals.map((s) => s.provider))).toEqual(new Set(["openai", "google"]));
  });

  it("a project counted twice (two metrics) still counts once per fingerprint", () => {
    const signals = groupFleetMovements(
      [row("a", -0.2), row("a", -0.25), row("b", -0.2), row("c", -0.2)],
      3
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]!.affected).toHaveLength(3);
  });

  it("zero measurable projects yields nothing, never a division by zero", () => {
    expect(groupFleetMovements([], 0)).toEqual([]);
  });
});
