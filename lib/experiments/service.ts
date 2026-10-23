/**
 * Intervention plans and evaluation (spec 151 B4–B6).
 *
 * draft → approved (frozen by trigger) → [linked to the intervention that
 * records what shipped] → evaluated on read against its post waves.
 * A change after approval is a new version (`revisePlan`), never an edit.
 * Evaluations are computed on read and never stored, so they always reflect
 * the immutable rows they came from.
 */
import { z } from "zod";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { CURRENT_REVISION } from "@/db/mentions";
import { assertCanWrite, assertProjectAccess, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { firstZodMessage } from "@/lib/service-helpers";
import { extractServedModel, instrumentKey, samplingOf } from "@/lib/ai/served-model";
import { domainBelongsTo, urlDomain } from "@/lib/parsing/prepass";
import {
  evaluateExperiment,
  summarizeLearning,
  type Evaluation,
  type LearningSummary,
  type PlanInput,
  type Wave,
} from "@/lib/experiments/evaluate";

export const PLAN_METRICS = ["recommendation_rate", "mention_rate", "owned_citation_rate", "top_three_rate", "first_position_rate"] as const;
export const PLAN_DESIGNS = ["descriptive", "matched_comparison", "preregistered_controlled", "staggered"] as const;

const planSchema = z.object({
  projectId: z.string().uuid(),
  hypothesis: z.string().trim().min(10).max(2000),
  interventionType: z.string().trim().min(2).max(80),
  entityCompanyId: z.string().uuid(),
  targetIntent: z.string().trim().max(200).optional(),
  targetPromptIds: z.array(z.string().uuid()).default([]),
  controlPromptIds: z.array(z.string().uuid()).default([]),
  controlCompanyIds: z.array(z.string().uuid()).default([]),
  instrumentKey: z.string().min(3),
  primaryMetric: z.enum(PLAN_METRICS),
  expectedDirection: z.enum(["increase", "decrease"]).default("increase"),
  mde: z.number().gt(0).max(1).optional(),
  design: z.enum(PLAN_DESIGNS),
  plannedImplementation: z.string().trim().min(5).max(2000),
  measurementSchedule: z.array(z.string().regex(/^\+\d+w$/)).min(1).default(["+2w", "+6w", "+12w"]),
  knownConfounders: z.array(z.string().trim().min(1).max(300)).default([]),
  baselineRunIds: z.array(z.string().uuid()).default([]),
  estimatedCostUsd: z.number().min(0).optional(),
  opportunityId: z.string().uuid().optional(),
});
export type PlanDraftInput = z.input<typeof planSchema>;

function overlap(a: string[], b: string[]): boolean {
  const set = new Set(a);
  return b.some((x) => set.has(x));
}

function validatePlan(input: z.infer<typeof planSchema>): string | null {
  if (overlap(input.targetPromptIds, input.controlPromptIds)) return "A prompt cannot be both a target and a control.";
  if (input.controlCompanyIds.includes(input.entityCompanyId)) return "The entity cannot be its own control.";
  if (input.design !== "descriptive" && input.controlPromptIds.length === 0 && input.controlCompanyIds.length === 0) {
    return "A controlled design needs control prompts or control entities (or choose the descriptive design).";
  }
  return null;
}

export async function createPlanDraft(user: CurrentUser, raw: unknown): Promise<ActionResult<{ planId: string; planKey: string }>> {
  const parsed = planSchema.safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  const input = parsed.data;
  const invalid = validatePlan(input);
  if (invalid) return fail(new ClassifiedError("validation", invalid));
  try {
    assertCanWrite(user);
    const row = await sql.begin(async (tx) => {
      const [created] = await tx`
        insert into intervention_plans (project_id, hypothesis, intervention_type, entity_company_id, target_intent,
          target_prompt_ids, control_prompt_ids, control_company_ids, instrument_key, primary_metric,
          expected_direction, mde, design, planned_implementation, measurement_schedule, known_confounders,
          baseline_run_ids, estimated_cost_usd, opportunity_id, created_by)
        values (${input.projectId}, ${input.hypothesis}, ${input.interventionType}, ${input.entityCompanyId},
          ${input.targetIntent ?? null}, ${input.targetPromptIds}, ${input.controlPromptIds}, ${input.controlCompanyIds},
          ${input.instrumentKey}, ${input.primaryMetric}, ${input.expectedDirection}, ${input.mde ?? null}, ${input.design},
          ${input.plannedImplementation}, ${input.measurementSchedule}, ${input.knownConfounders}, ${input.baselineRunIds},
          ${input.estimatedCostUsd ?? null}, ${input.opportunityId ?? null}, ${user.id})
        returning id, plan_key
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "experiment.plan_drafted",
        entity: "intervention_plan",
        entityId: created!.id as string,
        projectId: input.projectId,
        detail: { design: input.design, primaryMetric: input.primaryMetric },
      });
      return created!;
    });
    return ok({ planId: row.id as string, planKey: row.planKey as string });
  } catch (err) {
    return fail(err);
  }
}

/** Approval freezes the plan. It requires a baseline: at least one run, and
 * two waves ≥ 6 days apart unless the approver records why not. */
export async function approvePlan(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ planId: string; baselineWaves: number }>> {
  const parsed = z.object({ planId: z.string().uuid(), singleBaselineReason: z.string().trim().min(5).optional() }).safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  try {
    assertCanWrite(user);
    const [plan] = await sql`select * from intervention_plans where id = ${parsed.data.planId}`;
    if (!plan) return fail(new ClassifiedError("not_found", "Plan not found."));
    if (plan.status !== "draft") return fail(new ClassifiedError("conflict", `Plan is ${plan.status}.`));
    const runs = await sql`
      select id, started_at from runs where id = any(${plan.baselineRunIds as string[]})
        and project_id = ${plan.projectId} and status in ('completed', 'partial')
      order by started_at
    `;
    if (runs.length === 0) return fail(new ClassifiedError("validation", "Attach at least one finished baseline run before approving."));
    const spanDays =
      runs.length >= 2 ? ((runs.at(-1)!.startedAt as Date).getTime() - (runs[0]!.startedAt as Date).getTime()) / 86400000 : 0;
    const waves = spanDays >= 6 ? 2 : 1;
    if (waves < 2 && !parsed.data.singleBaselineReason) {
      return fail(
        new ClassifiedError("validation", "Two baseline waves at least 6 days apart are required, or record why a single baseline is acceptable.")
      );
    }
    await sql.begin(async (tx) => {
      const confounders = waves < 2
        ? [...((plan.knownConfounders as string[]) ?? []), `single baseline accepted: ${parsed.data.singleBaselineReason}`]
        : (plan.knownConfounders as string[]);
      // Final draft write, then the approving write that freezes it.
      await tx`update intervention_plans set known_confounders = ${confounders} where id = ${plan.id} and status = 'draft'`;
      await tx`
        update intervention_plans set status = 'approved', approved_by = ${user.id}, approved_at = now()
        where id = ${plan.id} and status = 'draft'
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "experiment.plan_approved",
        entity: "intervention_plan",
        entityId: plan.id as string,
        projectId: plan.projectId as string,
        detail: { baselineWaves: waves },
      });
    });
    // Release 151: the no-change benchmark (and a descriptive prior when real
    // history allows) is recorded at approval — before anything can ship.
    try {
      const { recordBenchmarkPredictions } = await import("@/lib/experiments/predictions");
      await recordBenchmarkPredictions(plan.id as string);
    } catch (err) {
      const { log } = await import("@/lib/logger");
      log("warn", "experiment.benchmark_prediction_failed", { planId: plan.id, error: err instanceof Error ? err.message : "unknown" });
    }
    return ok({ planId: plan.id as string, baselineWaves: waves });
  } catch (err) {
    return fail(err);
  }
}

/** Link the intervention that records what shipped (once). */
export async function linkPlanIntervention(user: CurrentUser, raw: unknown): Promise<ActionResult<{ planId: string }>> {
  const parsed = z.object({ planId: z.string().uuid(), interventionId: z.string().uuid() }).safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  try {
    assertCanWrite(user);
    const [plan] = await sql`select project_id, status, intervention_id from intervention_plans where id = ${parsed.data.planId}`;
    if (!plan) return fail(new ClassifiedError("not_found", "Plan not found."));
    if (plan.status !== "approved") return fail(new ClassifiedError("conflict", "Only an approved plan is linked to what shipped."));
    const [intervention] = await sql`select project_id from interventions where id = ${parsed.data.interventionId}`;
    if (!intervention || intervention.projectId !== plan.projectId) {
      return fail(new ClassifiedError("validation", "The intervention belongs to another project."));
    }
    await sql.begin(async (tx) => {
      await tx`update intervention_plans set intervention_id = ${parsed.data.interventionId} where id = ${parsed.data.planId}`;
      await writeAudit(tx, {
        userId: user.id,
        action: "experiment.plan_linked",
        entity: "intervention_plan",
        entityId: parsed.data.planId,
        projectId: plan.projectId as string,
        detail: { interventionId: parsed.data.interventionId },
      });
    });
    return ok({ planId: parsed.data.planId });
  } catch (err) {
    return fail(err);
  }
}

/** A changed plan is a new draft version; the approved one is superseded. */
export async function revisePlan(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ planId: string; version: number }>> {
  const parsed = z.object({ planId: z.string().uuid(), changes: planSchema.partial().omit({ projectId: true }), reason: z.string().trim().min(5) }).safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  try {
    assertCanWrite(user);
    const [old] = await sql`select * from intervention_plans where id = ${parsed.data.planId}`;
    if (!old) return fail(new ClassifiedError("not_found", "Plan not found."));
    if (old.status !== "approved" && old.status !== "draft") return fail(new ClassifiedError("conflict", `Plan is ${old.status}.`));
    const merged = planSchema.parse({
      projectId: old.projectId,
      hypothesis: old.hypothesis,
      interventionType: old.interventionType,
      entityCompanyId: old.entityCompanyId,
      targetIntent: old.targetIntent ?? undefined,
      targetPromptIds: old.targetPromptIds,
      controlPromptIds: old.controlPromptIds,
      controlCompanyIds: old.controlCompanyIds,
      instrumentKey: old.instrumentKey,
      primaryMetric: old.primaryMetric,
      expectedDirection: old.expectedDirection,
      mde: old.mde === null ? undefined : Number(old.mde),
      design: old.design,
      plannedImplementation: old.plannedImplementation,
      measurementSchedule: old.measurementSchedule,
      knownConfounders: [...(old.knownConfounders as string[]), `revised: ${parsed.data.reason}`],
      baselineRunIds: old.baselineRunIds,
      estimatedCostUsd: old.estimatedCostUsd === null ? undefined : Number(old.estimatedCostUsd),
      opportunityId: old.opportunityId ?? undefined,
      ...parsed.data.changes,
    });
    const invalid = validatePlan(merged);
    if (invalid) return fail(new ClassifiedError("validation", invalid));
    const created = await sql.begin(async (tx) => {
      await tx`update intervention_plans set status = ${old.status === "draft" ? "withdrawn" : "superseded"} where id = ${old.id}`;
      const [row] = await tx`
        insert into intervention_plans (project_id, plan_key, version, supersedes, hypothesis, intervention_type,
          entity_company_id, target_intent, target_prompt_ids, control_prompt_ids, control_company_ids, instrument_key,
          primary_metric, expected_direction, mde, design, planned_implementation, measurement_schedule,
          known_confounders, baseline_run_ids, estimated_cost_usd, opportunity_id, created_by)
        values (${merged.projectId}, ${old.planKey}, ${(old.version as number) + 1}, ${old.id}, ${merged.hypothesis},
          ${merged.interventionType}, ${merged.entityCompanyId}, ${merged.targetIntent ?? null}, ${merged.targetPromptIds},
          ${merged.controlPromptIds}, ${merged.controlCompanyIds}, ${merged.instrumentKey}, ${merged.primaryMetric},
          ${merged.expectedDirection}, ${merged.mde ?? null}, ${merged.design}, ${merged.plannedImplementation},
          ${merged.measurementSchedule}, ${merged.knownConfounders}, ${merged.baselineRunIds},
          ${merged.estimatedCostUsd ?? null}, ${merged.opportunityId ?? null}, ${user.id})
        returning id, version
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "experiment.plan_revised",
        entity: "intervention_plan",
        entityId: row!.id as string,
        projectId: merged.projectId,
        detail: { supersedes: old.id, reason: parsed.data.reason },
      });
      return row!;
    });
    return ok({ planId: created.id as string, version: created.version as number });
  } catch (err) {
    return fail(err);
  }
}

/** Load runs as evaluation waves, one per (run, instrument). Shared with
 * report v2 (lib/reports/measurement-v2.ts). */
export async function wavesForRuns(runIds: string[], metric: string, companyIds: string[]): Promise<Wave[]> {
  if (runIds.length === 0) return [];
  const runs = await sql`select id, started_at from runs where id = any(${runIds})`;
  // Same rule as scoring (spec 050): mock answers never count outside tests.
  const { mockScoringAllowed } = await import("@/lib/ai/registry");
  const allowMock = mockScoringAllowed();
  const responses = await sql`
    select r.id, r.run_id, r.prompt_id, r.provider, r.model, r.request_params, r.served_model, r.raw_payload
    from responses r
    where r.run_id = any(${runIds}) and r.error is null and (${allowMock} or r.provider <> 'mock')
  `;
  const mentions = await sql`
    select m.response_id, m.company_id, m.recommended, m.list_position, m.cited_urls, c.domain
    from mentions m join responses r on r.id = m.response_id join companies c on c.id = m.company_id
    where r.run_id = any(${runIds}) and m.mentioned and m.company_id = any(${companyIds}) and ${CURRENT_REVISION}
  `;
  const hit = (m: Record<string, unknown>): boolean => {
    switch (metric) {
      case "mention_rate":
        return true;
      case "recommendation_rate":
        return Boolean(m.recommended);
      case "first_position_rate":
        return m.listPosition === 1;
      case "top_three_rate":
        return m.listPosition !== null && (m.listPosition as number) <= 3;
      case "owned_citation_rate":
        return ((m.citedUrls as string[]) ?? []).some((u) => domainBelongsTo(urlDomain(u), m.domain as string | null));
      default:
        return false;
    }
  };
  const hits = new Set(mentions.filter(hit).map((m) => `${m.responseId as string}|${m.companyId as string}`));
  const waves = new Map<string, Wave>();
  for (const r of responses) {
    const key = instrumentKey({ provider: r.provider as string, model: r.model as string, sampling: samplingOf(r.requestParams) });
    const waveKey = `${r.runId as string}|${key}`;
    let w = waves.get(waveKey);
    if (!w) {
      const run = runs.find((x) => x.id === r.runId);
      w = { runId: r.runId as string, startedAt: run!.startedAt as Date, instrumentKey: key, servedModels: [], answers: [], hits };
      waves.set(waveKey, w);
    }
    w.answers.push({ promptId: r.promptId as string, responseId: r.id as string });
    const served = (r.servedModel as string | null) ?? extractServedModel(r.provider as string, r.rawPayload);
    if (served && !w.servedModels.includes(served)) w.servedModels.push(served);
  }
  return [...waves.values()];
}

export interface PlanEvaluation {
  planId: string;
  interventionId: string | null;
  evaluation: Evaluation;
}

export async function evaluatePlan(user: CurrentUser, planId: string): Promise<PlanEvaluation> {
  const [row] = await sql`select project_id from intervention_plans where id = ${planId}`;
  if (!row) throw new ClassifiedError("not_found", "Plan not found.");
  await assertProjectAccess(user, row.projectId as string);
  return evaluatePlanUnchecked(planId);
}

/** Evaluation without an access check — for server-side composition whose
 * caller has already authorized the project (report snapshots). */
export async function evaluatePlanUnchecked(planId: string): Promise<PlanEvaluation> {
  const [plan] = await sql`
    select p.*, i.shipped_at from intervention_plans p
    left join interventions i on i.id = p.intervention_id
    where p.id = ${planId}
  `;
  if (!plan) throw new ClassifiedError("not_found", "Plan not found.");
  const postRunIds = plan.interventionId
    ? (await sql`select run_id from intervention_runs where intervention_id = ${plan.interventionId} and role = 'post'`).map((r) => r.runId as string)
    : [];
  const companyIds = [plan.entityCompanyId as string, ...((plan.controlCompanyIds as string[]) ?? [])];
  const finishedPost = postRunIds.length
    ? (await sql`select id from runs where id = any(${postRunIds}) and status in ('completed', 'partial')`).map((r) => r.id as string)
    : [];
  const [baseline, post] = await Promise.all([
    wavesForRuns(plan.baselineRunIds as string[], plan.primaryMetric as string, companyIds),
    wavesForRuns(finishedPost, plan.primaryMetric as string, companyIds),
  ]);
  const input: PlanInput = {
    planId,
    entityCompanyId: plan.entityCompanyId as string,
    instrumentKey: plan.instrumentKey as string,
    expectedDirection: plan.expectedDirection as "increase" | "decrease",
    mde: plan.mde === null ? null : Number(plan.mde),
    design: plan.design as PlanInput["design"],
    targetPromptIds: plan.targetPromptIds as string[],
    controlPromptIds: plan.controlPromptIds as string[],
    controlCompanyIds: plan.controlCompanyIds as string[],
    approvedAt: (plan.approvedAt as Date | null) ?? null,
    shippedAt: plan.shippedAt ? new Date(plan.shippedAt as string | Date) : null,
    estimatedCostUsd: plan.estimatedCostUsd === null ? null : Number(plan.estimatedCostUsd),
    knownConfounders: plan.knownConfounders as string[],
  };
  return { planId, interventionId: (plan.interventionId as string | null) ?? null, evaluation: evaluateExperiment(input, baseline, post) };
}

/** Cross-client descriptive summary over every approved, linked plan. */
export async function learningSummary(user: CurrentUser): Promise<LearningSummary[]> {
  assertCanWrite(user); // staff-only: crosses client boundaries
  const plans = await sql`
    select id, intervention_type, instrument_key from intervention_plans
    where status = 'approved' and intervention_id is not null
  `;
  const rows = [];
  for (const p of plans) {
    const { evaluation } = await evaluatePlan(user, p.id as string);
    rows.push({
      interventionType: p.interventionType as string,
      instrumentKey: p.instrumentKey as string,
      evidenceTier: evaluation.evidenceTier,
      verdict: evaluation.verdict,
      estimate: evaluation.estimate,
    });
  }
  return summarizeLearning(rows);
}

export async function listPlans(user: CurrentUser, projectId: string) {
  await assertProjectAccess(user, projectId);
  return sql`
    select id, plan_key, version, status, hypothesis, intervention_type, primary_metric, design,
      instrument_key, intervention_id, approved_at, created_at
    from intervention_plans where project_id = ${projectId}
    order by created_at desc
  `;
}
