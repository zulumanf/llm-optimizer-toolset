/**
 * Graded comparability (spec 062): known-answer fixtures per rule, plus the
 * precedence rule (worst triggered grade wins, every reason retained).
 */
import { describe, expect, it } from "vitest";
import {
  assessComparability,
  type InstrumentSnapshot,
} from "@/lib/attribution/comparability";

const snapshot = (over: Partial<InstrumentSnapshot> = {}): InstrumentSnapshot => ({
  runId: "run-1",
  promptSetVersionId: "psv-1",
  providers: [
    { provider: "openai", model: "gpt-5", repetitions: 4 },
    { provider: "anthropic", model: "claude-fable-5", repetitions: 4 },
  ],
  scoringVersions: ["scoring-v3"],
  ...over,
});

describe("assessComparability", () => {
  it("grades an unchanged two-baseline instrument high, with no reasons", () => {
    const result = assessComparability(
      [snapshot({ runId: "b1" }), snapshot({ runId: "b2" })],
      snapshot({ runId: "p1" })
    );
    expect(result).toEqual({ grade: "high", reasons: [] });
  });

  it("is not comparable with no baselines", () => {
    const result = assessComparability([], snapshot());
    expect(result.grade).toBe("not_comparable");
    expect(result.reasons).toEqual(["no baseline runs"]);
  });

  it("is not comparable across scoring versions (the docs/06 forbidden read)", () => {
    const result = assessComparability(
      [snapshot({ runId: "b1" }), snapshot({ runId: "b2" })],
      snapshot({ runId: "p1", scoringVersions: ["scoring-v4"] })
    );
    expect(result.grade).toBe("not_comparable");
    expect(result.reasons.join(" ")).toContain("scoring version changed");
  });

  it("is not comparable when baselines themselves span scoring versions", () => {
    const result = assessComparability(
      [
        snapshot({ runId: "b1", scoringVersions: ["scoring-v2"] }),
        snapshot({ runId: "b2", scoringVersions: ["scoring-v3"] }),
      ],
      snapshot({ runId: "p1" })
    );
    expect(result.grade).toBe("not_comparable");
    expect(result.reasons.join(" ")).toContain("multiple scoring versions");
  });

  it("is not comparable when the post run has no scores yet", () => {
    const result = assessComparability(
      [snapshot({ runId: "b1" }), snapshot({ runId: "b2" })],
      snapshot({ runId: "p1", scoringVersions: [] })
    );
    expect(result.grade).toBe("not_comparable");
    expect(result.reasons.join(" ")).toContain("no scored results");
  });

  it("is not comparable across prompt set versions", () => {
    const result = assessComparability(
      [snapshot({ runId: "b1" }), snapshot({ runId: "b2" })],
      snapshot({ runId: "p1", promptSetVersionId: "psv-2" })
    );
    expect(result.grade).toBe("not_comparable");
    expect(result.reasons.join(" ")).toContain("prompt set version differs");
  });

  it("degrades to low when the provider set changed", () => {
    const result = assessComparability(
      [snapshot({ runId: "b1" }), snapshot({ runId: "b2" })],
      snapshot({
        runId: "p1",
        providers: [{ provider: "openai", model: "gpt-5", repetitions: 8 }],
      })
    );
    expect(result.grade).toBe("low");
    expect(result.reasons.join(" ")).toContain("provider set changed");
    expect(result.reasons.join(" ")).toContain("-anthropic");
  });

  it("degrades to low when a shared provider's model changed", () => {
    const result = assessComparability(
      [snapshot({ runId: "b1" }), snapshot({ runId: "b2" })],
      snapshot({
        runId: "p1",
        providers: [
          { provider: "openai", model: "gpt-6", repetitions: 4 },
          { provider: "anthropic", model: "claude-fable-5", repetitions: 4 },
        ],
      })
    );
    expect(result.grade).toBe("low");
    expect(result.reasons.join(" ")).toContain("gpt-5 → gpt-6");
  });

  it("degrades to medium when repetition totals differ by more than 2×", () => {
    const result = assessComparability(
      [snapshot({ runId: "b1" }), snapshot({ runId: "b2" })],
      snapshot({
        runId: "p1",
        providers: [
          { provider: "openai", model: "gpt-5", repetitions: 12 },
          { provider: "anthropic", model: "claude-fable-5", repetitions: 12 },
        ],
      })
    );
    expect(result.grade).toBe("medium");
    expect(result.reasons.join(" ")).toContain("repetition totals differ");
  });

  it("degrades to medium on a single baseline run", () => {
    const result = assessComparability([snapshot({ runId: "b1" })], snapshot({ runId: "p1" }));
    expect(result.grade).toBe("medium");
    expect(result.reasons).toEqual([
      "single baseline run — pre-ship variance is unmeasured",
    ]);
  });

  it("worst grade wins and every triggered reason is retained", () => {
    const result = assessComparability(
      [snapshot({ runId: "b1" })],
      snapshot({
        runId: "p1",
        scoringVersions: ["scoring-v4"],
        providers: [{ provider: "openai", model: "gpt-6", repetitions: 40 }],
      })
    );
    expect(result.grade).toBe("not_comparable");
    expect(result.reasons.length).toBeGreaterThanOrEqual(4);
  });
});
