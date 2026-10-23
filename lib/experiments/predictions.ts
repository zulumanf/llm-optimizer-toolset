/**
 * Offline evaluation of intervention predictions (release 151).
 *
 * The adaptive engine is only allowed to LEARN once it is shown to predict
 * better than doing nothing. This module:
 *   1. records predictions before a change ships (refuses late ones);
 *   2. always records a `no_change_baseline` (predicts 0) and, when enough
 *      REAL history exists, a `descriptive_prior` (median of past observed
 *      estimates for the same intervention type and instrument) — the
 *      interpretable benchmarks any future model must beat;
 *   3. scores predictions against evaluator outcomes with proper scoring
 *      rules (absolute error, interval coverage, direction, Brier), only on
 *      comparable, non-synthetic, pre-shipping pairs, and refuses aggregate
 *      claims below a minimum sample.
 *
 * It never trains anything, never reads synthetic (mock-provider or
 * internal/sentinel project) outcomes, and never calls an observed change a
 * causal effect.
 */
import { z } from "zod";
import { sql } from "@/db/client";
import { assertCanWrite, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { firstZodMessage } from "@/lib/service-helpers";
import {
  BASELINE_PREDICTOR,
  descriptivePrior,
  NO_CHANGE_PREDICTION,
  PRIOR_PREDICTOR,
  summarizePredictor,
  type Outcome,
  type PredictionInput,
  type PredictorReport,
} from "@/lib/experiments/prediction-scoring";

export * from "@/lib/experiments/prediction-scoring";

// ------------------------------------------------------------------ db side

const predictionSchema = z
  .object({
    planId: z.string().uuid(),
    predictor: z.string().trim().min(2).max(80),
    predictorVersion: z.string().trim().min(2).max(80),
    basis: z.enum(["no_change_baseline", "descriptive_prior", "rule", "human"]),
    predictedChange: z.number().min(-1).max(1),
    predictedLow: z.number().min(-1).max(1),
    predictedHigh: z.number().min(-1).max(1),
    probabilityImprovement: z.number().min(0).max(1),
    rationale: z.string().trim().min(3).max(2000),
    features: z.record(z.unknown()).default({}),
  })
  .refine((v) => v.predictedLow <= v.predictedChange && v.predictedChange <= v.predictedHigh, "The interval must contain the point prediction.");

/** Record a prediction. Refused once the plan's change has shipped. */
export async function recordPrediction(user: CurrentUser | null, raw: unknown): Promise<ActionResult<{ predictionId: string }>> {
  const parsed = predictionSchema.safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  const v = parsed.data;
  try {
    if (user) assertCanWrite(user);
    const [plan] = await sql`
      select p.id, p.status, i.shipped_at from intervention_plans p
      left join interventions i on i.id = p.intervention_id where p.id = ${v.planId}
    `;
    if (!plan) return fail(new ClassifiedError("not_found", "Plan not found."));
    if (plan.status === "withdrawn" || plan.status === "superseded") {
      return fail(new ClassifiedError("conflict", `Plan is ${plan.status as string}.`));
    }
    if (plan.shippedAt && new Date(plan.shippedAt as string | Date).getTime() <= Date.now()) {
      return fail(new ClassifiedError("conflict", "The change has shipped; a prediction now would be hindsight."));
    }
    const [row] = await sql`
      insert into intervention_predictions (plan_id, predictor, predictor_version, basis, predicted_change,
        predicted_low, predicted_high, probability_improvement, rationale, features, created_by)
      values (${v.planId}, ${v.predictor}, ${v.predictorVersion}, ${v.basis}, ${v.predictedChange},
        ${v.predictedLow}, ${v.predictedHigh}, ${v.probabilityImprovement}, ${v.rationale},
        ${sql.json(v.features as never)}, ${user?.id ?? null})
      returning id
    `;
    return ok({ predictionId: row!.id as string });
  } catch (err) {
    return fail(err);
  }
}

/** Is a plan's evidence synthetic (mock answers, or an internal/sentinel project)? */
async function syntheticPlans(planIds: string[]): Promise<Set<string>> {
  if (planIds.length === 0) return new Set();
  const rows = await sql`
    select p.id from intervention_plans p
    join projects pr on pr.id = p.project_id
    where p.id = any(${planIds}) and (
      pr.kind in ('internal', 'sentinel')
      or exists (select 1 from responses r where r.run_id = any(p.baseline_run_ids) and r.provider = 'mock')
      or exists (select 1 from intervention_runs ir join responses r on r.run_id = ir.run_id
                 where ir.intervention_id = p.intervention_id and r.provider = 'mock')
    )
  `;
  return new Set(rows.map((r) => r.id as string));
}

/** Benchmarks recorded automatically when a plan is approved. */
export async function recordBenchmarkPredictions(planId: string): Promise<{ recorded: string[] }> {
  const recorded: string[] = [];
  const base = await recordPrediction(null, {
    planId,
    predictor: BASELINE_PREDICTOR.name,
    predictorVersion: BASELINE_PREDICTOR.version,
    basis: "no_change_baseline",
    ...NO_CHANGE_PREDICTION,
    rationale: "Benchmark: nothing changes. Any predictor must beat this to be used.",
  });
  if (base.ok) recorded.push(BASELINE_PREDICTOR.name);

  const [plan] = await sql`select intervention_type, instrument_key from intervention_plans where id = ${planId}`;
  if (!plan) return { recorded };
  const history = await pastRealEvaluations(plan.interventionType as string, plan.instrumentKey as string, planId);
  const prior = descriptivePrior(history);
  if (prior) {
    const r = await recordPrediction(null, {
      planId,
      predictor: PRIOR_PREDICTOR.name,
      predictorVersion: PRIOR_PREDICTOR.version,
      basis: "descriptive_prior",
      ...prior,
      rationale: `Median and 10–90% range of ${history.length} past real, comparable evaluations of the same intervention type on the same instrument.`,
      features: { pastEvaluations: history.length },
    });
    if (r.ok) recorded.push(PRIOR_PREDICTOR.name);
  }
  return { recorded };
}

async function pastRealEvaluations(interventionType: string, instrumentKey: string, excludePlanId: string) {
  const { evaluatePlanUnchecked } = await import("@/lib/experiments/service");
  const plans = await sql`
    select id from intervention_plans
    where status = 'approved' and intervention_id is not null and id <> ${excludePlanId}
      and intervention_type = ${interventionType} and instrument_key = ${instrumentKey}
  `;
  const synthetic = await syntheticPlans(plans.map((p) => p.id as string));
  const out: { estimate: number; improvement: boolean }[] = [];
  for (const p of plans) {
    if (synthetic.has(p.id as string)) continue;
    const { evaluation } = await evaluatePlanUnchecked(p.id as string);
    if (evaluation.comparability === "comparable" && evaluation.estimate !== null && evaluation.evidenceTier >= 2) {
      out.push({ estimate: evaluation.estimate, improvement: evaluation.verdict === "improvement_observed" });
    }
  }
  return out;
}

/** Offline evaluation over every recorded prediction (staff only). */
export async function evaluatePredictions(user: CurrentUser): Promise<PredictorReport[]> {
  assertCanWrite(user);
  const { evaluatePlanUnchecked } = await import("@/lib/experiments/service");
  const predictions = await sql`
    select ip.plan_id, ip.predictor, ip.predictor_version, ip.created_at,
      ip.predicted_change::float8 as predicted_change, ip.predicted_low::float8 as predicted_low,
      ip.predicted_high::float8 as predicted_high, ip.probability_improvement::float8 as probability_improvement,
      i.shipped_at, p.intervention_id
    from intervention_predictions ip
    join intervention_plans p on p.id = ip.plan_id
    left join interventions i on i.id = p.intervention_id
    order by ip.created_at
  `;
  const planIds = [...new Set(predictions.map((p) => p.planId as string))];
  const synthetic = await syntheticPlans(planIds);
  const outcomes = new Map<string, Outcome | null>();
  for (const planId of planIds) {
    const row = predictions.find((p) => p.planId === planId)!;
    if (!row.interventionId) {
      outcomes.set(planId, null);
      continue;
    }
    const { evaluation } = await evaluatePlanUnchecked(planId);
    outcomes.set(planId, {
      verdict: evaluation.verdict,
      estimate: evaluation.estimate,
      comparable: evaluation.comparability === "comparable",
      synthetic: synthetic.has(planId),
      recordedBeforeShipping: true, // refined per prediction below
    });
  }
  const groups = new Map<string, { predictor: string; version: string; pairs: { prediction: PredictionInput; outcome: Outcome | null }[] }>();
  for (const p of predictions) {
    const key = `${p.predictor as string}|${p.predictorVersion as string}`;
    const g = groups.get(key) ?? { predictor: p.predictor as string, version: p.predictorVersion as string, pairs: [] };
    const base = outcomes.get(p.planId as string) ?? null;
    const shipped = p.shippedAt ? new Date(p.shippedAt as string | Date).getTime() : null;
    g.pairs.push({
      prediction: {
        predictedChange: Number(p.predictedChange),
        predictedLow: Number(p.predictedLow),
        predictedHigh: Number(p.predictedHigh),
        probabilityImprovement: Number(p.probabilityImprovement),
      },
      outcome: base ? { ...base, recordedBeforeShipping: shipped === null || (p.createdAt as Date).getTime() < shipped } : null,
    });
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => summarizePredictor(g.predictor, g.version, g.pairs));
}
