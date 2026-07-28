import { describe, expect, it } from "vitest";
import {
  computeVerdicts,
  windowsOverlap,
  type ScoreInput,
} from "@/lib/attribution/verdict";

let counter = 0;
function score(overrides: Partial<ScoreInput>): ScoreInput {
  counter += 1;
  return {
    scoreId: `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
    runId: "base-1",
    metric: "recommendation_rate",
    provider: "all",
    value: 0.4,
    sampleSize: 40,
    scoringVersion: "v1.0",
    ...overrides,
  };
}

describe("computeVerdicts", () => {
  it("pools baselines (unweighted mean) and flags a notable consistent rise", () => {
    const baseline = [
      score({ runId: "b1", value: 0.35 }),
      score({ runId: "b2", value: 0.45 }),
      score({ runId: "b1", provider: "openai", value: 0.35 }),
      score({ runId: "b2", provider: "openai", value: 0.45 }),
      score({ runId: "b1", provider: "anthropic", value: 0.35 }),
      score({ runId: "b2", provider: "anthropic", value: 0.45 }),
    ];
    const post = [
      score({ runId: "p1", value: 0.55 }),
      score({ runId: "p1", provider: "openai", value: 0.56 }),
      score({ runId: "p1", provider: "anthropic", value: 0.54 }),
    ];
    const verdicts = computeVerdicts(baseline, post);
    expect(verdicts).toHaveLength(1);
    const v = verdicts[0]!;
    expect(v.baselineValue).toBeCloseTo(0.4); // pooled mean of 0.35/0.45
    expect(v.delta).toBeCloseTo(0.15);
    expect(v.verdict).toBe("notable");
  });

  it("returns insufficient below N=30 per side", () => {
    const verdicts = computeVerdicts(
      [score({ runId: "b1", sampleSize: 10 })],
      [score({ runId: "p1", value: 0.6, sampleSize: 10 })]
    );
    expect(verdicts[0]?.verdict).toBe("insufficient");
  });

  it("refuses cross-scoring-version comparison", () => {
    const verdicts = computeVerdicts(
      [score({ runId: "b1", scoringVersion: "v1.0" })],
      [score({ runId: "p1", value: 0.6, scoringVersion: "v2.0" })]
    );
    expect(verdicts[0]?.verdict).toBe("not_comparable");
  });

  it("authority score gets a delta but no noise verdict", () => {
    const verdicts = computeVerdicts(
      [score({ runId: "b1", metric: "authority_score", value: 60 })],
      [score({ runId: "p1", metric: "authority_score", value: 80 })]
    );
    expect(verdicts[0]?.delta).toBeCloseTo(20);
    expect(verdicts[0]?.verdict).toBeNull();
  });

  it("produces one verdict per metric per post run", () => {
    const baseline = [
      score({ runId: "b1" }),
      score({ runId: "b1", metric: "mention_rate", value: 0.8 }),
    ];
    const post = [
      score({ runId: "p1", value: 0.42 }),
      score({ runId: "p1", metric: "mention_rate", value: 0.81 }),
      score({ runId: "p2", value: 0.44 }),
      score({ runId: "p2", metric: "mention_rate", value: 0.82 }),
    ];
    expect(computeVerdicts(baseline, post)).toHaveLength(4);
  });
});

describe("windowsOverlap (confound window ±12w)", () => {
  it("flags interventions shipped within 84 days of each other", () => {
    expect(windowsOverlap("2026-07-01", "2026-08-15")).toBe(true);
    expect(windowsOverlap("2026-07-01", "2026-07-01")).toBe(true);
  });
  it("clears interventions farther apart", () => {
    expect(windowsOverlap("2026-01-01", "2026-07-01")).toBe(false);
  });
});
