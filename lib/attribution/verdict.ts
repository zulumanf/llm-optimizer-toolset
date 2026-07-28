/**
 * Attribution verdicts (spec 007): pooled baseline vs each post run, using
 * the docs/06 change-detection rule. Verdicts are computed on read, never
 * stored or editable. Pure functions — the service supplies score rows.
 */
import { changeVerdict, MIN_N_PER_SIDE, RATE_METRICS } from "@/lib/reports/deltas";

export interface ScoreInput {
  scoreId: string;
  runId: string;
  metric: string;
  provider: string;
  value: number;
  sampleSize: number;
  scoringVersion: string;
}

export interface MetricVerdict {
  metric: string;
  postRunId: string;
  baselineValue: number;
  postValue: number;
  postScoreId: string;
  delta: number;
  verdict:
    | "notable"
    | "within_noise"
    | "insufficient"
    | "not_comparable"
    | null;
}

/** Unweighted mean across baseline runs of the 'all'-provider value. */
function pooled(
  scores: ScoreInput[],
  metric: string,
  provider: string
): { value: number; n: number } | null {
  const rows = scores.filter(
    (s) => s.metric === metric && s.provider === provider
  );
  if (rows.length === 0) return null;
  return {
    value: rows.reduce((a, s) => a + s.value, 0) / rows.length,
    n: rows.reduce((a, s) => a + s.sampleSize, 0),
  };
}

export function computeVerdicts(
  baselineScores: ScoreInput[],
  postScores: ScoreInput[]
): MetricVerdict[] {
  const verdicts: MetricVerdict[] = [];
  const postRuns = [...new Set(postScores.map((s) => s.runId))];
  const metrics = [
    ...new Set(postScores.filter((s) => s.provider === "all").map((s) => s.metric)),
  ];
  const baselineVersions = new Set(baselineScores.map((s) => s.scoringVersion));

  for (const runId of postRuns) {
    const runScores = postScores.filter((s) => s.runId === runId);
    for (const metric of metrics) {
      const post = runScores.find(
        (s) => s.metric === metric && s.provider === "all"
      );
      const baseline = pooled(baselineScores, metric, "all");
      if (!post || !baseline) continue;

      // Cross-version comparison is forbidden (docs/06)
      if (!baselineVersions.has(post.scoringVersion) || baselineVersions.size > 1) {
        verdicts.push({
          metric,
          postRunId: runId,
          baselineValue: baseline.value,
          postValue: post.value,
          postScoreId: post.scoreId,
          delta: post.value - baseline.value,
          verdict: "not_comparable",
        });
        continue;
      }

      // Noise verdicts (incl. insufficient) apply to rate metrics only —
      // the authority composite reports a delta with no verdict (docs/06)
      if (
        RATE_METRICS.has(metric) &&
        (post.sampleSize < MIN_N_PER_SIDE || baseline.n < MIN_N_PER_SIDE)
      ) {
        verdicts.push({
          metric,
          postRunId: runId,
          baselineValue: baseline.value,
          postValue: post.value,
          postScoreId: post.scoreId,
          delta: post.value - baseline.value,
          verdict: "insufficient",
        });
        continue;
      }

      const providers = [
        ...new Set(
          runScores
            .filter((s) => s.metric === metric && s.provider !== "all")
            .map((s) => s.provider)
        ),
      ];
      const perProvider = providers.flatMap((provider) => {
        const p = runScores.find(
          (s) => s.metric === metric && s.provider === provider
        );
        const b = pooled(baselineScores, metric, provider);
        return p && b
          ? [{
              provider,
              current: p.value,
              previous: b.value,
              nCurrent: p.sampleSize,
              nPrevious: b.n,
            }]
          : [];
      });

      verdicts.push({
        metric,
        postRunId: runId,
        baselineValue: baseline.value,
        postValue: post.value,
        postScoreId: post.scoreId,
        delta: post.value - baseline.value,
        verdict: changeVerdict(
          metric,
          {
            current: post.value,
            previous: baseline.value,
            nCurrent: post.sampleSize,
            nPrevious: baseline.n,
          },
          perProvider
        ),
      });
    }
  }
  return verdicts;
}

/** Overlap window for confound detection: shipped date + 12 weeks. */
export const CONFOUND_WINDOW_DAYS = 84;

export function windowsOverlap(shippedA: string, shippedB: string): boolean {
  const a = new Date(shippedA).getTime();
  const b = new Date(shippedB).getTime();
  return Math.abs(a - b) < CONFOUND_WINDOW_DAYS * 24 * 3600 * 1000;
}
