import { describe, expect, it } from "vitest";
import {
  computeVerdicts,
  providerMovement,
  summarizeProviders,
  windowsOverlap,
  type ProviderDelta,
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

describe("per-provider movement (spec 067, retest-context-v1)", () => {
  it("bands movement on the shared thresholds, insufficient below N=30", () => {
    expect(providerMovement(0.12, 40, 40)).toBe("improved");
    expect(providerMovement(-0.1, 40, 40)).toBe("declined");
    expect(providerMovement(0.09, 40, 40)).toBe("within_noise");
    expect(providerMovement(0.5, 29, 40)).toBe("insufficient");
    expect(providerMovement(0.5, 40, 29)).toBe("insufficient");
  });

  it("summarizes counts and judges consistency against the headline direction", () => {
    const providers: ProviderDelta[] = [
      { provider: "openai", delta: 0.2, movement: "improved" },
      { provider: "anthropic", delta: 0.15, movement: "improved" },
      { provider: "google", delta: 0.02, movement: "within_noise" },
      { provider: "perplexity", delta: 0.3, movement: "insufficient" },
    ];
    const { providerSummary, consistent } = summarizeProviders(providers, 0.14);
    expect(providerSummary).toContain("improved on 2/4 providers");
    expect(providerSummary).toContain("within noise on 1");
    expect(providerSummary).toContain("insufficient sample on 1");
    expect(consistent).toBe(true);
  });

  it("flags inconsistency when a provider moved against the headline", () => {
    const { consistent } = summarizeProviders(
      [
        { provider: "openai", delta: 0.3, movement: "improved" },
        { provider: "anthropic", delta: -0.2, movement: "declined" },
      ],
      0.05
    );
    expect(consistent).toBe(false);
  });

  it("returns null consistency when nothing moved notably, null summary when empty", () => {
    expect(
      summarizeProviders(
        [{ provider: "openai", delta: 0.01, movement: "within_noise" }],
        0.01
      ).consistent
    ).toBeNull();
    expect(summarizeProviders([], 0.2)).toEqual({
      providerSummary: null,
      consistent: null,
    });
  });

  it("computeVerdicts carries the per-provider read on rate metrics only", () => {
    const baseline = [
      score({ runId: "b1", value: 0.35 }),
      score({ runId: "b1", provider: "openai", value: 0.35 }),
      score({ runId: "b1", provider: "anthropic", value: 0.35 }),
      score({ runId: "b1", metric: "authority_score", value: 40 }),
    ];
    const post = [
      score({ runId: "p1", value: 0.55 }),
      score({ runId: "p1", provider: "openai", value: 0.6 }),
      score({ runId: "p1", provider: "anthropic", value: 0.5 }),
      score({ runId: "p1", metric: "authority_score", value: 55 }),
    ];
    const verdicts = computeVerdicts(baseline, post);
    const rate = verdicts.find((v) => v.metric === "recommendation_rate")!;
    expect(rate.providers.map((p) => p.provider).sort()).toEqual([
      "anthropic",
      "openai",
    ]);
    expect(rate.providers.every((p) => p.movement === "improved")).toBe(true);
    expect(rate.consistent).toBe(true);
    expect(rate.providerSummary).toContain("improved on 2/2");
    const authority = verdicts.find((v) => v.metric === "authority_score")!;
    expect(authority.providers).toEqual([]);
    expect(authority.providerSummary).toBeNull();
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
