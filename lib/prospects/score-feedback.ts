/**
 * Outcomes → scoring recommendations (spec 043, target req. 21). Compares
 * final-score components between prospects that converted (ever reached
 * `replied` or beyond) and those that didn't, and RECOMMENDS — it never
 * writes. Weight changes happen only through scoring_weight_sets by a
 * human (spec 039). Below the cohort floor it says "insufficient data"
 * instead of drawing a thin conclusion.
 */
import { sql } from "@/db/client";
import { PROSPECT_STAGES, type ProspectStage } from "@/lib/prospects/constants";

export const SCORE_FEEDBACK_VERSION = "score-feedback-v1";
export const MIN_COHORT = 5;
/** Component-mean difference (0–100 scale) worth mentioning at all. */
const MATERIAL_DELTA = 5;

export const CONVERSION_STAGE: ProspectStage = "replied";
const CONVERSION_INDEX = PROSPECT_STAGES.indexOf(CONVERSION_STAGE);

export const FEEDBACK_EPILOGUE =
  "Recommendations only — weights change through a new scoring_weight_sets version, applied by a human.";

export interface ScoredOutcomeRow {
  components: Record<string, number | null>;
  converted: boolean;
}

export interface ComponentComparison {
  component: string;
  convertedMean: number | null;
  unconvertedMean: number | null;
  delta: number | null;
  convertedN: number;
  unconvertedN: number;
}

export interface ScoreFeedbackReport {
  version: typeof SCORE_FEEDBACK_VERSION;
  convertedCount: number;
  unconvertedCount: number;
  sufficient: boolean;
  comparisons: ComponentComparison[];
  recommendations: string[];
  epilogue: typeof FEEDBACK_EPILOGUE;
}

function mean(values: number[]): number | null {
  return values.length === 0
    ? null
    : values.reduce((a, b) => a + b, 0) / values.length;
}

export function scoreOutcomeReport(rows: ScoredOutcomeRow[]): ScoreFeedbackReport {
  const converted = rows.filter((r) => r.converted);
  const unconverted = rows.filter((r) => !r.converted);
  const base: Omit<ScoreFeedbackReport, "comparisons" | "recommendations" | "sufficient"> = {
    version: SCORE_FEEDBACK_VERSION,
    convertedCount: converted.length,
    unconvertedCount: unconverted.length,
    epilogue: FEEDBACK_EPILOGUE,
  };
  if (converted.length < MIN_COHORT || unconverted.length < MIN_COHORT) {
    return {
      ...base,
      sufficient: false,
      comparisons: [],
      recommendations: [
        `Insufficient data: ${converted.length} converted vs ${unconverted.length} unconverted scored prospects — at least ${MIN_COHORT} of each are needed before component comparisons mean anything.`,
      ],
    };
  }

  const componentKeys = [
    ...new Set(rows.flatMap((r) => Object.keys(r.components))),
  ].sort();
  const comparisons: ComponentComparison[] = componentKeys.map((component) => {
    const convertedValues = converted
      .map((r) => r.components[component])
      .filter((v): v is number => v !== null && v !== undefined);
    const unconvertedValues = unconverted
      .map((r) => r.components[component])
      .filter((v): v is number => v !== null && v !== undefined);
    const convertedMean = mean(convertedValues);
    const unconvertedMean = mean(unconvertedValues);
    return {
      component,
      convertedMean,
      unconvertedMean,
      delta:
        convertedMean !== null && unconvertedMean !== null
          ? convertedMean - unconvertedMean
          : null,
      convertedN: convertedValues.length,
      unconvertedN: unconvertedValues.length,
    };
  });

  const material = comparisons
    .filter((c) => c.delta !== null && Math.abs(c.delta) >= MATERIAL_DELTA)
    .sort((a, b) => Math.abs(b.delta!) - Math.abs(a.delta!));
  const label = (key: string): string => key.replace(/([A-Z])/g, " $1").toLowerCase();
  const recommendations = material.map((c) =>
    c.delta! > 0
      ? `Prospects that replied averaged ${c.delta!.toFixed(1)} points higher on ${label(c.component)} (${c.convertedMean!.toFixed(0)} vs ${c.unconvertedMean!.toFixed(0)}, n=${c.convertedN}/${c.unconvertedN}) — consider weighting it up.`
      : `Prospects that replied averaged ${Math.abs(c.delta!).toFixed(1)} points LOWER on ${label(c.component)} (${c.convertedMean!.toFixed(0)} vs ${c.unconvertedMean!.toFixed(0)}, n=${c.convertedN}/${c.unconvertedN}) — its current weight may be selecting the wrong prospects.`
  );
  if (recommendations.length === 0) {
    recommendations.push(
      "No component separates converted from unconverted prospects by a material margin yet — keep the current weights."
    );
  }
  return { ...base, sufficient: true, comparisons, recommendations };
}

/** Assemble from stored breakdowns + stage history, then run the pure report. */
export async function acquisitionScoreFeedback(): Promise<ScoreFeedbackReport> {
  const rows = await sql`
    select p.qualification_breakdown, p.stage,
      coalesce(array_agg(h.to_stage) filter (where h.to_stage is not null), '{}')
        as visited
    from prospects p
    left join prospect_stage_history h on h.prospect_id = p.id
    where p.archived_at is null and p.qualification_breakdown is not null
    group by p.id, p.qualification_breakdown, p.stage
  `;
  const ladderIndex = new Map<string, number>(PROSPECT_STAGES.map((s, i) => [s, i]));
  return scoreOutcomeReport(
    rows.map((r) => {
      const breakdown = r.qualificationBreakdown as {
        components?: Record<string, number | null>;
      };
      const stages = [r.stage as ProspectStage, ...((r.visited as ProspectStage[]) ?? [])];
      const converted = stages.some((s) => {
        const index = ladderIndex.get(s);
        return index !== undefined && index >= CONVERSION_INDEX;
      });
      return { components: breakdown.components ?? {}, converted };
    })
  );
}
