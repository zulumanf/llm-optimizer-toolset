import { describe, expect, it } from "vitest";
import { evaluateExperiment, summarizeLearning, type PlanInput, type Wave } from "@/lib/experiments/evaluate";
import { seededRandom } from "@/lib/stats";

const INSTRUMENT = "openai|m|prompt_text_only|provider_default";
const ENTITY = "entity";
const RIVAL = "rival";
const day = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 86400000);

/** A wave over `prompts` treated + `controls` control prompts × reps, with
 * per-prompt hit probabilities plus `lift` on treated prompts only. */
function wave(rand: () => number, opts: { runId: string; at: Date; base: number[]; controls: number[]; lift: number; reps: number; served?: string }): Wave {
  const answers: Wave["answers"] = [];
  const hits = new Set<string>();
  const add = (promptId: string, p: number) => {
    for (let r = 0; r < opts.reps; r += 1) {
      const responseId = `${opts.runId}:${promptId}:${r}`;
      answers.push({ promptId, responseId });
      if (rand() < p) hits.add(`${responseId}|${ENTITY}`);
      if (rand() < 0.3) hits.add(`${responseId}|${RIVAL}`);
    }
  };
  opts.base.forEach((p, i) => add(`t${i}`, Math.min(1, p + opts.lift)));
  opts.controls.forEach((p, i) => add(`c${i}`, p));
  return { runId: opts.runId, startedAt: opts.at, instrumentKey: INSTRUMENT, servedModels: [opts.served ?? "m-2026"], answers, hits };
}

const plan = (over: Partial<PlanInput> = {}): PlanInput => ({
  planId: "plan",
  entityCompanyId: ENTITY,
  instrumentKey: INSTRUMENT,
  expectedDirection: "increase",
  mde: 0.1,
  design: "preregistered_controlled",
  targetPromptIds: Array.from({ length: 40 }, (_, i) => `t${i}`),
  controlPromptIds: Array.from({ length: 40 }, (_, i) => `c${i}`),
  controlCompanyIds: [],
  approvedAt: day(0),
  shippedAt: day(20),
  estimatedCostUsd: 150,
  knownConfounders: [],
  ...over,
});

function scenario(lift: number, seed = 1) {
  const rand = seededRandom(seed);
  const base = Array.from({ length: 40 }, () => 0.1 + rand() * 0.2);
  const controls = Array.from({ length: 40 }, () => 0.1 + rand() * 0.2);
  const baseline = [
    wave(rand, { runId: "b1", at: day(5), base, controls, lift: 0, reps: 4 }),
    wave(rand, { runId: "b2", at: day(12), base, controls, lift: 0, reps: 4 }),
  ];
  const post = [wave(rand, { runId: "p1", at: day(40), base, controls, lift, reps: 4 })];
  return { baseline, post };
}

describe("evaluateExperiment (simulated known effects)", () => {
  it("recovers a known +25-point lift inside its interval; tier 3 pre-registered", () => {
    const { baseline, post } = scenario(0.25);
    const e = evaluateExperiment(plan(), baseline, post);
    expect(e.verdict).toBe("improvement_observed");
    expect(e.estimator).toBe("did_control_prompts");
    expect(e.evidenceTier).toBe(3);
    expect(e.interval![0]).toBeLessThanOrEqual(0.25);
    expect(e.interval![1]).toBeGreaterThanOrEqual(0.25);
    expect(e.explanation).toMatch(/not proof of cause/);
  });

  it("a true null is never reported as an improvement", () => {
    for (const seed of [2, 3, 4, 5, 6]) {
      const { baseline, post } = scenario(0, seed);
      const e = evaluateExperiment(plan({ mde: 0.3 }), baseline, post);
      expect(["no_detectable_change", "inconclusive"]).toContain(e.verdict);
    }
  });

  it("reports a negative change honestly", () => {
    const rand = seededRandom(9);
    const base = Array.from({ length: 40 }, () => 0.5);
    const controls = Array.from({ length: 40 }, () => 0.5);
    const baseline = [wave(rand, { runId: "b1", at: day(5), base, controls, lift: 0, reps: 4 }), wave(rand, { runId: "b2", at: day(12), base, controls, lift: 0, reps: 4 })];
    const post = [wave(rand, { runId: "p1", at: day(40), base, controls, lift: -0.35, reps: 4 })];
    expect(evaluateExperiment(plan(), baseline, post).verdict).toBe("negative_change_observed");
  });

  it("is not comparable when the served model changed or the instrument is absent", () => {
    const { baseline } = scenario(0.25);
    const rand = seededRandom(1);
    const post = [wave(rand, { runId: "p1", at: day(40), base: [0.2], controls: [0.2], lift: 0, reps: 4, served: "m-2027" })];
    expect(evaluateExperiment(plan(), baseline, post)).toMatchObject({ verdict: "not_comparable", comparability: "not_comparable" });
    expect(evaluateExperiment(plan({ instrumentKey: "other" }), baseline, post).verdict).toBe("not_comparable");
  });

  it("downgrades evidence without controls or without pre-registration, and flags a single baseline", () => {
    const { baseline, post } = scenario(0.25);
    expect(evaluateExperiment(plan({ controlPromptIds: [], controlCompanyIds: [] }), baseline, post)).toMatchObject({ evidenceTier: 1, estimator: "paired_before_after" });
    const late = evaluateExperiment(plan({ approvedAt: day(30) }), baseline, post);
    expect(late.evidenceTier).toBe(2);
    expect(late.confounders.join(" ")).toMatch(/not pre-registered/);
    const single = evaluateExperiment(plan(), baseline.slice(0, 1), post);
    expect(single.confounders.join(" ")).toMatch(/single baseline/);
    expect(evaluateExperiment(plan({ controlPromptIds: [], controlCompanyIds: [RIVAL] }), baseline, post).estimator).toBe("did_control_entities");
  });

  it("a baseline wave on or after the ship date is not comparable (review M2)", () => {
    const { baseline, post } = scenario(0.25);
    const e = evaluateExperiment(plan({ shippedAt: day(10) }), baseline, post);
    expect(e.verdict).toBe("not_comparable");
    expect(e.comparabilityReasons.join(" ")).toMatch(/baseline wave started on or after/);
  });

  it("no_detectable_change requires the whole interval inside ±MDE (review M1)", () => {
    const { baseline, post } = scenario(0, 3);
    const tight = evaluateExperiment(plan({ mde: 0.5 }), baseline, post);
    expect(tight.verdict).toBe("no_detectable_change");
    expect(tight.interval![0]).toBeGreaterThan(-0.5);
    expect(tight.interval![1]).toBeLessThan(0.5);
    // An MDE smaller than the interval's reach cannot be ruled out.
    const loose = evaluateExperiment(plan({ mde: 0.01 }), baseline, post);
    expect(loose.verdict).toBe("inconclusive");
  });

  it("is deterministic", () => {
    const { baseline, post } = scenario(0.1, 7);
    expect(evaluateExperiment(plan(), baseline, post)).toEqual(evaluateExperiment(plan(), baseline, post));
  });
});

describe("summarizeLearning", () => {
  it("counts verdicts and withholds a median below the minimum group size", () => {
    const rows = [
      { interventionType: "profile_completion", instrumentKey: "k", evidenceTier: 3, verdict: "improvement_observed" as const, estimate: 0.1 },
      { interventionType: "profile_completion", instrumentKey: "k", evidenceTier: 3, verdict: "no_detectable_change" as const, estimate: 0.01 },
    ];
    const [s] = summarizeLearning(rows);
    expect(s).toMatchObject({ evaluations: 2, medianEstimate: null });
    expect(s?.verdicts.improvement_observed).toBe(1);
    const many = Array.from({ length: 5 }, (_, i) => ({ ...rows[0]!, estimate: i / 10 }));
    expect(summarizeLearning(many)[0]?.medianEstimate).toBeCloseTo(0.2, 10);
  });
});
