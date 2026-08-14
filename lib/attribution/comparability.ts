/**
 * Graded retest comparability (spec 062). The old read was binary:
 * `not_comparable` on scoring-version mismatch, silence about everything
 * else — while provider set, model strings, repetitions, and baseline count
 * were already stored on the runs and simply never composed. A verdict
 * asserted over unexamined instrument drift is the platform's highest-risk
 * correctness gap; this module makes the drift legible.
 *
 * Pure functions with known-answer tests (docs/09). Grades contextualize
 * verdicts, they never edit them, and nothing is stored — comparability is
 * derived on read, like verdicts themselves.
 */
import type { ProviderConfig } from "@/lib/runs/cells";

export const COMPARABILITY_VERSION = "comparability-v1";

export const COMPARABILITY_GRADES = [
  "high",
  "medium",
  "low",
  "not_comparable",
] as const;
export type ComparabilityGrade = (typeof COMPARABILITY_GRADES)[number];

/** Everything about a run that determines whether its numbers may be
 * compared with another run's. */
export interface InstrumentSnapshot {
  runId: string;
  promptSetVersionId: string;
  providers: ProviderConfig[];
  /** Distinct scoring versions present on the run's score rows. */
  scoringVersions: string[];
}

export interface ComparabilityAssessment {
  grade: ComparabilityGrade;
  /** One entry per triggered rule — the grade must be explainable. */
  reasons: string[];
}

/** If baseline and post repetition totals differ by more than this factor,
 * the sample sizes are no longer the same experiment. */
export const REPETITION_RATIO_LIMIT = 2;

const ORDER: Record<ComparabilityGrade, number> = {
  high: 0,
  medium: 1,
  low: 2,
  not_comparable: 3,
};

function worse(a: ComparabilityGrade, b: ComparabilityGrade): ComparabilityGrade {
  return ORDER[a] >= ORDER[b] ? a : b;
}

function totalRepetitions(providers: ProviderConfig[]): number {
  return providers.reduce((sum, p) => sum + p.repetitions, 0);
}

/**
 * Assess whether a post run's numbers may be read against the pooled
 * baselines. Worst triggered rule wins; every triggered rule contributes a
 * reason, so the grade is an argument, not a pronouncement.
 */
export function assessComparability(
  baselines: InstrumentSnapshot[],
  post: InstrumentSnapshot
): ComparabilityAssessment {
  if (baselines.length === 0) {
    return { grade: "not_comparable", reasons: ["no baseline runs"] };
  }

  let grade: ComparabilityGrade = "high";
  const reasons: string[] = [];
  const flag = (level: ComparabilityGrade, reason: string) => {
    grade = worse(grade, level);
    reasons.push(reason);
  };

  // Scoring version — the docs/06 forbidden read, restated from verdict.ts.
  const baselineVersions = new Set(baselines.flatMap((b) => b.scoringVersions));
  if (baselineVersions.size > 1) {
    flag("not_comparable", "baseline runs span multiple scoring versions");
  }
  const unmatched = post.scoringVersions.filter((v) => !baselineVersions.has(v));
  if (post.scoringVersions.length === 0) {
    flag("not_comparable", "post run has no scored results yet");
  } else if (unmatched.length > 0) {
    flag(
      "not_comparable",
      `scoring version changed (baseline ${[...baselineVersions].join(", ") || "none"} vs post ${post.scoringVersions.join(", ")})`
    );
  }

  // Prompt instrument. Post runs are started on the intervention's frozen
  // version by construction, so a mismatch means manual interference.
  const otherVersion = baselines.find(
    (b) => b.promptSetVersionId !== post.promptSetVersionId
  );
  if (otherVersion) {
    flag("not_comparable", "prompt set version differs between baseline and post");
  }

  // Provider instrument, judged against the latest baseline's config (the
  // one the scheduler reuses).
  const reference = baselines[0]!;
  const refByProvider = new Map(reference.providers.map((p) => [p.provider, p]));
  const postByProvider = new Map(post.providers.map((p) => [p.provider, p]));
  const missing = [...refByProvider.keys()].filter((p) => !postByProvider.has(p));
  const added = [...postByProvider.keys()].filter((p) => !refByProvider.has(p));
  if (missing.length > 0 || added.length > 0) {
    flag(
      "low",
      `provider set changed (${[
        ...missing.map((p) => `-${p}`),
        ...added.map((p) => `+${p}`),
      ].join(", ")})`
    );
  }
  for (const [provider, refConfig] of refByProvider) {
    const postConfig = postByProvider.get(provider);
    if (postConfig && postConfig.model !== refConfig.model) {
      flag(
        "low",
        `${provider} model changed (${refConfig.model} → ${postConfig.model})`
      );
    }
  }

  // Sample-size shape.
  const refReps = totalRepetitions(reference.providers);
  const postReps = totalRepetitions(post.providers);
  if (refReps > 0 && postReps > 0) {
    const ratio = Math.max(refReps, postReps) / Math.min(refReps, postReps);
    if (ratio > REPETITION_RATIO_LIMIT) {
      flag(
        "medium",
        `repetition totals differ by ${ratio.toFixed(1)}× (${refReps} vs ${postReps})`
      );
    }
  }
  if (baselines.length < 2) {
    flag("medium", "single baseline run — pre-ship variance is unmeasured");
  }

  return { grade, reasons };
}
