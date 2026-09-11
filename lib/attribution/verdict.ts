/**
 * Attribution verdicts (spec 007): pooled baseline vs each post run, using
 * the docs/06 change-detection rule. Verdicts are computed on read, never
 * stored or editable. Pure functions — the service supplies score rows.
 */
import {
  changeVerdict,
  MIN_N_PER_SIDE,
  NOTABLE_DELTA,
  RATE_METRICS,
} from "@/lib/reports/deltas";

export interface ScoreInput {
  scoreId: string;
  runId: string;
  metric: string;
  provider: string;
  value: number;
  sampleSize: number;
  scoringVersion: string;
}

export type ProviderMovement =
  | "improved"
  | "declined"
  | "within_noise"
  | "insufficient";

/** One provider's own baseline→post read (spec 067, retest-context-v1) —
 * the numbers changeVerdict always consumed, now kept instead of thrown
 * away. Movement uses the SAME constants as the aggregate verdict
 * (NOTABLE_DELTA, MIN_N_PER_SIDE) — never a second definition. */
export interface ProviderDelta {
  provider: string;
  delta: number;
  movement: ProviderMovement;
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
  /** Rate metrics only (the docs/06 change-detection scope); empty
   * otherwise. */
  providers: ProviderDelta[];
  /** "improved on 3/4 providers, within noise on 1" — counted, never
   * causal. Null when no provider read exists. */
  providerSummary: string | null;
  /** True when every provider that moved notably moved in the headline
   * direction. Null when nothing moved notably anywhere. */
  consistent: boolean | null;
}

/** Movement for one provider's delta under the shared thresholds. */
export function providerMovement(
  delta: number,
  nCurrent: number,
  nPrevious: number
): ProviderMovement {
  if (nCurrent < MIN_N_PER_SIDE || nPrevious < MIN_N_PER_SIDE) return "insufficient";
  if (delta >= NOTABLE_DELTA) return "improved";
  if (delta <= -NOTABLE_DELTA) return "declined";
  return "within_noise";
}

/** The counted read across providers; pure so fixtures can pin it. */
export function summarizeProviders(
  providers: ProviderDelta[],
  headlineDelta: number
): { providerSummary: string | null; consistent: boolean | null } {
  if (providers.length === 0) {
    return { providerSummary: null, consistent: null };
  }
  const counts: Record<ProviderMovement, number> = {
    improved: 0,
    declined: 0,
    within_noise: 0,
    insufficient: 0,
  };
  for (const p of providers) counts[p.movement] += 1;
  const total = providers.length;
  const parts: string[] = [];
  if (counts.improved > 0) parts.push(`improved on ${counts.improved}/${total} providers`);
  if (counts.declined > 0) parts.push(`declined on ${counts.declined}/${total}`);
  if (counts.within_noise > 0) parts.push(`within noise on ${counts.within_noise}`);
  if (counts.insufficient > 0) parts.push(`insufficient sample on ${counts.insufficient}`);

  const moved = providers.filter(
    (p) => p.movement === "improved" || p.movement === "declined"
  );
  const consistent =
    moved.length === 0
      ? null
      : moved.every((p) =>
          headlineDelta >= 0 ? p.movement === "improved" : p.movement === "declined"
        );
  return { providerSummary: parts.join(", "), consistent };
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
          providers: [],
          providerSummary: null,
          consistent: null,
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
          providers: [],
          providerSummary: null,
          consistent: null,
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

      // The per-provider read (spec 067): the same rows changeVerdict
      // consumes, kept instead of thrown away — rate metrics only, the
      // docs/06 change-detection scope.
      const headlineDelta = post.value - baseline.value;
      const providerDeltas: ProviderDelta[] = RATE_METRICS.has(metric)
        ? perProvider.map((p) => ({
            provider: p.provider,
            delta: p.current - p.previous,
            movement: providerMovement(
              p.current - p.previous,
              p.nCurrent,
              p.nPrevious
            ),
          }))
        : [];

      verdicts.push({
        metric,
        postRunId: runId,
        baselineValue: baseline.value,
        postValue: post.value,
        postScoreId: post.scoreId,
        delta: headlineDelta,
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
        providers: providerDeltas,
        ...summarizeProviders(providerDeltas, headlineDelta),
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
