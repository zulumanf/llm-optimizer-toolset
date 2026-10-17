/**
 * Client onboarding orchestration (spec 151 C1). Composition over the
 * existing engagement, measurement and optimization services:
 *
 *  - `onboardingChecklist` derives every step's state from records (nothing
 *    stored, so it cannot drift from reality) with one next action each;
 *  - `prepareMeasurement` does the safe mechanical steps in one confirmed
 *    action: pin the instrument, freeze the cohort, start baseline wave 1
 *    and schedule wave 2 (+7 days) on the same instrument and version.
 *
 * Commercial gates, market confirmation, claim approval and plan approval
 * stay human steps in their own services.
 */
import { z } from "zod";
import { sql } from "@/db/client";
import { READ_SCORING_VERSION } from "@/db/scores";
import { writeAudit } from "@/db/audit";
import { enqueueJob } from "@/db/jobs";
import { latestCohort, pinnedInstrument } from "@/db/measurement";
import { assertCanWrite, assertProjectAccess, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { firstZodMessage } from "@/lib/service-helpers";
import { SCORING_VERSION } from "@/lib/constants";
import { BUDGET_MAX_USD } from "@/lib/runs/validation";
import { ensurePinnedInstrument, freezeCohortTx } from "@/lib/measurement/service";
import { startRun } from "@/lib/runs/service";
import { log } from "@/lib/logger";

/** Waves at least this far apart estimate run-to-run noise (lib/experiments). */
export const BASELINE_WAVE_GAP_DAYS = 7;
export const MIN_APPROVED_CLAIMS = 3;
export const BASELINE_WAVE_JOB = "start_baseline_wave";
const waveLabel = (wave: number) => `Baseline wave ${wave}`;

export type StepActor = "system" | "operator" | "client";

export interface OnboardingStep {
  key: string;
  label: string;
  done: boolean;
  actor: StepActor;
  evidence: string;
  nextAction: string | null;
}

export async function onboardingChecklist(user: CurrentUser, projectId: string): Promise<{ steps: OnboardingStep[]; next: OnboardingStep | null }> {
  await assertProjectAccess(user, projectId);
  const [project] = await sql`
    select p.id, p.subject_company_id, c.name as subject_name, c.domain as subject_domain
    from projects p left join companies c on c.id = p.subject_company_id where p.id = ${projectId}
  `;
  if (!project) throw new ClassifiedError("not_found", "Project not found.");
  const [engagement] = await sql`
    select id, contract_status, stage, market_definition_confirmed_at, client_legal_name
    from client_engagements where project_id = ${projectId} order by created_at desc limit 1
  `;
  const [{ claims }] = (await sql`
    select count(*)::int as claims from claims where project_id = ${projectId} and status = 'approved'
  `) as unknown as [{ claims: number }];
  const instrument = await pinnedInstrument(projectId);
  const cohort = await latestCohort(projectId);
  const baselines = await sql`
    select r.id, r.started_at, r.status,
      exists (select 1 from score_estimates e where e.run_id = r.id and e.scoring_version = ${SCORING_VERSION}) as scored
    from runs r where r.project_id = ${projectId} and r.label like 'Baseline wave %'
    order by r.started_at
  `;
  const scored = baselines.filter((b) => b.scored);
  const spanDays =
    scored.length >= 2 ? ((scored.at(-1)!.startedAt as Date).getTime() - (scored[0]!.startedAt as Date).getTime()) / 86400000 : 0;
  const [{ findings }] = (await sql`select count(*)::int as findings from gap_findings where project_id = ${projectId}`) as unknown as [{ findings: number }];
  const [opp] = await sql`
    select count(*)::int as total, count(*) filter (where status not in ('proposed', 'dismissed'))::int as approved
    from opportunities where project_id = ${projectId}
  `;
  const [{ plans }] = (await sql`
    select count(*)::int as plans from intervention_plans where project_id = ${projectId} and status = 'approved'
  `) as unknown as [{ plans: number }];

  const steps: OnboardingStep[] = [
    {
      key: "engagement",
      label: "Client and engagement recorded",
      done: Boolean(engagement),
      actor: "operator",
      evidence: engagement ? `engagement ${String(engagement.id).slice(0, 8)} · ${engagement.stage as string}` : "no engagement",
      nextAction: engagement ? null : "Sign the client from its frozen quote (Engagement tab).",
    },
    {
      key: "contract",
      label: "Contract signed",
      done: engagement?.contractStatus === "signed",
      actor: "client",
      evidence: engagement ? `contract ${engagement.contractStatus as string}` : "—",
      nextAction: engagement?.contractStatus === "signed" ? null : "Record the signed agreement.",
    },
    {
      key: "identity",
      label: "Legal entity and measured identity",
      done: Boolean(project.subjectCompanyId && engagement?.clientLegalName),
      actor: "operator",
      evidence: project.subjectName ? `${project.subjectName as string}${project.subjectDomain ? ` · ${project.subjectDomain as string}` : ""}` : "no subject company",
      nextAction: project.subjectCompanyId && engagement?.clientLegalName ? null : "Set the subject company and the client's legal name.",
    },
    {
      key: "market",
      label: "Target market confirmed",
      done: Boolean(engagement?.marketDefinitionConfirmedAt),
      actor: "client",
      evidence: engagement?.marketDefinitionConfirmedAt ? "confirmed" : "unconfirmed",
      nextAction: engagement?.marketDefinitionConfirmedAt ? null : "Confirm the market definition with the client.",
    },
    {
      key: "claims",
      label: "Approved business facts",
      done: claims >= MIN_APPROVED_CLAIMS,
      actor: "operator",
      evidence: `${claims} approved claim(s)`,
      nextAction: claims >= MIN_APPROVED_CLAIMS ? null : `Approve at least ${MIN_APPROVED_CLAIMS} facts from client-supplied sources.`,
    },
    {
      key: "instrument",
      label: "Measurement instrument pinned",
      done: Boolean(instrument),
      actor: "system",
      evidence: instrument ? instrument.providers.map((p) => `${p.provider}/${p.model}×${p.repetitions}`).join(", ") : "not pinned",
      nextAction: instrument ? null : "Prepare measurement (pins the default instrument).",
    },
    {
      key: "cohort",
      label: "Competitor cohort frozen",
      done: Boolean(cohort),
      actor: "system",
      evidence: cohort ? `v${cohort.version} · ${cohort.companyIds.length} companies` : "not frozen",
      nextAction: cohort ? null : "Add competitors, then prepare measurement (freezes the cohort).",
    },
    {
      key: "baseline",
      label: "Two scored baseline waves",
      done: scored.length >= 2 && spanDays >= 6,
      actor: "system",
      evidence: `${baselines.length} wave(s) started, ${scored.length} scored${scored.length >= 2 ? `, ${spanDays.toFixed(0)} days apart` : ""}`,
      nextAction:
        baselines.length === 0
          ? "Prepare measurement (starts wave 1, schedules wave 2)."
          : scored.length < 2
            ? "Waiting for the baseline waves to finish and score."
            : null,
    },
    {
      key: "analysis",
      label: "Initial analysis",
      done: findings > 0,
      actor: "system",
      evidence: `${findings} gap finding(s)`,
      nextAction: findings > 0 ? null : "Gap analysis runs after scoring; check the run's queue.",
    },
    {
      key: "plan",
      label: "Optimization plan built",
      done: Number(opp?.total ?? 0) > 0,
      actor: "system",
      evidence: `${opp?.total ?? 0} opportunities`,
      nextAction: Number(opp?.total ?? 0) > 0 ? null : "Build the optimization plan.",
    },
    {
      key: "approval",
      label: "Plan reviewed and approved",
      done: Number(opp?.approved ?? 0) > 0,
      actor: "operator",
      evidence: `${opp?.approved ?? 0} approved`,
      nextAction: Number(opp?.approved ?? 0) > 0 ? null : "Approve the first opportunities with the client.",
    },
    {
      key: "experiment",
      label: "First intervention pre-registered",
      done: plans > 0,
      actor: "operator",
      evidence: `${plans} approved plan(s)`,
      nextAction: plans > 0 ? null : "Pre-register the first intervention before it ships.",
    },
  ];
  return { steps, next: steps.find((s) => !s.done) ?? null };
}

const prepareSchema = z.object({
  projectId: z.string().uuid(),
  promptSetVersionId: z.string().uuid(),
  budgetUsdPerWave: z.number().positive().max(BUDGET_MAX_USD),
});

/**
 * One confirmed action: pin, freeze, start wave 1, schedule wave 2.
 * Concurrency-safe and resumable (review finding M6): a session advisory
 * lock serializes double clicks for the project, and each wave is checked
 * separately, so a retry after a partial failure completes whatever is
 * missing instead of refusing forever.
 */
export async function prepareMeasurement(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ instrumentId: string; cohortId: string | null; wave1RunId: string; wave2JobId: string; resumed: boolean }>> {
  const parsed = prepareSchema.safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  const input = parsed.data;
  let reserved: Awaited<ReturnType<typeof sql.reserve>> | null = null;
  const lockKey = `prepare-measurement:${input.projectId}`;
  try {
    assertCanWrite(user);
    reserved = await sql.reserve();
    const [got] = await reserved`select pg_try_advisory_lock(hashtext(${lockKey})) as ok`;
    if (!got?.ok) {
      reserved.release();
      reserved = null;
      return fail(new ClassifiedError("conflict", "Measurement preparation is already in progress for this project."));
    }

    const [wave1] = await sql`select id from runs where project_id = ${input.projectId} and label = ${waveLabel(1)} limit 1`;
    const [wave2Run] = await sql`select id from runs where project_id = ${input.projectId} and label = ${waveLabel(2)} limit 1`;
    const [wave2Job] = await sql`
      select id from jobs where type = ${BASELINE_WAVE_JOB} and payload->>'projectId' = ${input.projectId}
        and status in ('queued', 'running', 'done') limit 1
    `;
    if (wave1 && (wave2Run || wave2Job)) {
      return fail(new ClassifiedError("conflict", "Baseline waves are already prepared for this project."));
    }
    const instrument = await ensurePinnedInstrument(input.projectId, user.id, "client onboarding");
    let cohortId: string | null = null;
    try {
      cohortId = (await sql.begin((tx) => freezeCohortTx(tx, input.projectId, "client onboarding baseline", user.id))).id;
    } catch (err) {
      if (!(err instanceof ClassifiedError && err.kind === "conflict")) throw err;
    }
    let wave1RunId = (wave1?.id as string | undefined) ?? null;
    if (!wave1RunId) {
      const started = await startRun(user, {
        projectId: input.projectId,
        promptSetVersionId: input.promptSetVersionId,
        providers: instrument.providers,
        budgetUsd: input.budgetUsdPerWave,
        label: waveLabel(1),
      });
      if (!started.ok) return fail(new ClassifiedError(started.error.kind, started.error.message));
      wave1RunId = started.data.id;
    }
    let wave2JobId = (wave2Job?.id as string | undefined) ?? null;
    if (!wave2JobId && !wave2Run) {
      wave2JobId = await sql.begin(async (tx) => {
        const id = await enqueueJob(tx, BASELINE_WAVE_JOB, {
          projectId: input.projectId,
          promptSetVersionId: input.promptSetVersionId,
          wave: 2,
          budgetUsd: input.budgetUsdPerWave,
          instrumentId: instrument.id,
        });
        await tx`update jobs set run_after = now() + make_interval(days => ${BASELINE_WAVE_GAP_DAYS}) where id = ${id}`;
        return id;
      });
    }
    const resumed = Boolean(wave1) || Boolean(wave2Job) || Boolean(wave2Run);
    await sql.begin((tx) =>
      writeAudit(tx, {
        userId: user.id,
        action: "onboarding.measurement_prepared",
        entity: "project",
        entityId: input.projectId,
        projectId: input.projectId,
        detail: { instrumentId: instrument.id, cohortId, wave1RunId, wave2JobId, resumed },
      })
    );
    return ok({ instrumentId: instrument.id, cohortId, wave1RunId, wave2JobId: wave2JobId ?? "", resumed });
  } catch (err) {
    return fail(err);
  } finally {
    if (reserved) {
      try {
        await reserved`select pg_advisory_unlock(hashtext(${lockKey}))`;
      } catch {
        // dead session: the lock died with it
      }
      try {
        reserved.release();
      } catch {
        // dead connection
      }
    }
  }
}

/** Worker handler for a scheduled baseline wave. Idempotent by label; uses
 * the instrument version recorded at scheduling, never a newer pin. */
export async function startBaselineWave(payload: {
  projectId: string;
  promptSetVersionId: string;
  wave: number;
  budgetUsd: number;
  instrumentId: string;
}): Promise<void> {
  const label = waveLabel(payload.wave);
  const [already] = await sql`select id from runs where project_id = ${payload.projectId} and label = ${label}`;
  if (already) {
    log("info", "onboarding.baseline_wave_exists", { projectId: payload.projectId, wave: payload.wave });
    return;
  }
  const [instrument] = await sql`select providers from measurement_instruments where id = ${payload.instrumentId}`;
  if (!instrument) throw new ClassifiedError("not_found", "Pinned instrument not found.");
  const started = await startRun(
    null,
    {
      projectId: payload.projectId,
      promptSetVersionId: payload.promptSetVersionId,
      providers: instrument.providers,
      budgetUsd: payload.budgetUsd,
      label,
    },
    "scheduled"
  );
  if (!started.ok) throw new ClassifiedError("internal", `Baseline wave ${payload.wave} failed to start: ${started.error.message}`);
}

/** Initial analysis in one action: gap analysis over the latest scored
 * baseline wave, then the optimization plan (composition only). */
export async function runInitialAnalysis(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ runId: string; findings: number; opportunities: number }>> {
  const parsed = z.object({ projectId: z.string().uuid() }).safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  try {
    assertCanWrite(user);
    const [run] = await sql`
      select r.id from runs r
      where r.project_id = ${parsed.data.projectId} and r.label like 'Baseline wave %'
        and exists (select 1 from scores s where s.run_id = r.id and s.scoring_version = ${READ_SCORING_VERSION})
      order by r.started_at desc limit 1
    `;
    if (!run) return fail(new ClassifiedError("conflict", "No scored baseline wave yet."));
    const { analyzeRun } = await import("@/lib/gaps/service");
    const gaps = await analyzeRun(user, { runId: run.id });
    if (!gaps.ok) return fail(new ClassifiedError(gaps.error.kind, gaps.error.message));
    const { buildOptimizationPlan } = await import("@/lib/optimization/plan");
    const plan = await buildOptimizationPlan(user, { projectId: parsed.data.projectId });
    if (!plan.ok) return fail(new ClassifiedError(plan.error.kind, plan.error.message));
    const [{ n }] = (await sql`select count(*)::int as n from gap_findings where run_id = ${run.id}`) as unknown as [{ n: number }];
    return ok({ runId: run.id as string, findings: n, opportunities: plan.data.total });
  } catch (err) {
    return fail(err);
  }
}
