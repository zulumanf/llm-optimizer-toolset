/**
 * Interventions (spec 007, docs/07): record what shipped, tie it to baseline
 * runs of a frozen version, schedule post re-runs (+2/+6/+12w) on the same
 * instrument, and compute verdicts on read. Overlapping interventions on the
 * same version are mutually flagged confounded — no silent averaging.
 */
import { z } from "zod";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { assertCanWrite, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { firstZodMessage } from "@/lib/service-helpers";
import { startRun } from "@/lib/runs/service";
import {
  computeVerdicts,
  windowsOverlap,
  type MetricVerdict,
  type ScoreInput,
} from "@/lib/attribution/verdict";
import {
  canTransition,
  deriveObservedStatus,
  type InterventionStatus,
} from "@/lib/attribution/lifecycle";
import {
  assessComparability,
  type ComparabilityGrade,
  type InstrumentSnapshot,
} from "@/lib/attribution/comparability";
import type { ProviderConfig } from "@/lib/runs/cells";
import { log } from "@/lib/logger";

export const POST_OFFSETS = ["+2w", "+6w", "+12w"] as const;
export type PostOffset = (typeof POST_OFFSETS)[number];
const OFFSET_DAYS: Record<PostOffset, number> = { "+2w": 14, "+6w": 42, "+12w": 84 };

import { INTERVENTION_TYPES } from "@/lib/attribution/constants";
export { INTERVENTION_TYPES, type InterventionType } from "@/lib/attribution/constants";

const createSchema = z.object({
  projectId: z.string().uuid(),
  title: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(1, "Title is required.").max(120)),
  description: z.string().max(2000).optional(),
  hypothesis: z.string().trim().max(500).optional(),
  shippedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  urls: z.array(z.string().url()).max(10).default([]),
  promptSetVersionId: z.string().uuid(),
  taskId: z.string().uuid().optional(),
  // Lifecycle fields (spec 051): who owns it, what it cost. Optional —
  // interventions predating the record stay null.
  ownerId: z.string().uuid().optional(),
  costUsd: z.number().nonnegative().optional(),
  interventionType: z.enum(INTERVENTION_TYPES).optional(),
  postOffsets: z.array(z.enum(POST_OFFSETS)).default([...POST_OFFSETS]),
});

export interface CreatedIntervention {
  interventionId: string;
  baselineRunIds: string[];
  baselineWeak: boolean;
  scheduledOffsets: PostOffset[];
}

export async function createIntervention(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<CreatedIntervention>> {
  const parsed = createSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const input = parsed.data;
  const shippedTime = new Date(input.shippedAt).getTime();
  if (shippedTime > Date.now() + 7 * 24 * 3600 * 1000) {
    return fail(
      new ClassifiedError("validation", "shipped_at is more than 7 days in the future.")
    );
  }
  try {
    assertCanWrite(user);
    const result = await sql.begin(async (tx) => {
      const [version] = await tx`
        select v.id, s.project_id from prompt_set_versions v
        join prompt_sets s on s.id = v.prompt_set_id
        where v.id = ${input.promptSetVersionId}
      `;
      if (!version) throw new ClassifiedError("not_found", "Version not found.");
      if (version.projectId !== input.projectId) {
        throw new ClassifiedError("validation", "Version belongs to another project.");
      }

      // Baseline proposal: the two most recent completed runs before shipping
      const baselines = await tx`
        select id, started_at, providers, budget_usd from runs
        where prompt_set_version_id = ${input.promptSetVersionId}
          and status in ('completed', 'partial')
          and started_at < (${input.shippedAt}::date + 1)
        order by started_at desc
        limit 2
      `;
      const weekApart =
        baselines.length === 2 &&
        Math.abs(
          (baselines[0]!.startedAt as Date).getTime() -
            (baselines[1]!.startedAt as Date).getTime()
        ) >= 6.5 * 24 * 3600 * 1000;
      const baselineWeak = baselines.length < 2 || !weekApart;

      // Initial lifecycle status states what this transaction actually does
      // (spec 062): with a baseline, post runs get scheduled below, so the
      // retest is pending; without one, the record merely says "shipped".
      const initialStatus: InterventionStatus =
        baselines.length > 0 && input.postOffsets.length > 0
          ? "retest_pending"
          : "shipped";
      const [row] = await tx`
        insert into interventions
          (project_id, title, description, hypothesis, shipped_at, urls,
           prompt_set_version_id, task_id, baseline_weak, created_by,
           owner_id, cost_usd, intervention_type, status)
        values
          (${input.projectId}, ${input.title}, ${input.description ?? null},
           ${input.hypothesis || null},
           ${input.shippedAt}, ${input.urls}, ${input.promptSetVersionId},
           ${input.taskId ?? null}, ${baselineWeak}, ${user.id},
           ${input.ownerId ?? null}, ${input.costUsd ?? null},
           ${input.interventionType ?? null}, ${initialStatus})
        returning id
      `;
      const interventionId = row?.id as string;

      // One outcome spine (spec 051, audit F43): the intervention loop and
      // the action_outcomes/learnings loop never met — intervention_id was
      // populated on no product path, so a learning could never cite a real
      // intervention's verdict. Recorded in the same transaction; the
      // existing outcome sweep measures it unchanged (+6w horizon matches
      // the retest schedule).
      const { recordAction } = await import("@/lib/outcomes/graph");
      await recordAction(tx, {
        projectId: input.projectId,
        actionType: "intervention_shipped",
        hypothesis: input.hypothesis ?? "",
        interventionId,
        taskId: input.taskId ?? null,
        landingUrls: input.urls,
        completedOn: input.shippedAt,
        expectedDaysToImpact: 42,
      });

      for (const baseline of baselines) {
        await tx`
          insert into intervention_runs (intervention_id, run_id, role)
          values (${interventionId}, ${baseline.id}, 'baseline')
        `;
      }

      // Live verification (spec 051): every claimed URL gets fetched and
      // its result recorded — enqueued with the insert so it cannot be
      // forgotten. markPublished flows through here and inherits it.
      if (input.urls.length > 0) {
        await tx`
          insert into jobs (type, payload)
          values ('verify_intervention_urls', ${tx.json({ interventionId } as never)})
        `;
      }

      // Post runs reuse the latest baseline's exact config (same instrument,
      // docs/07); without any baseline run there is nothing to re-run against
      const scheduledOffsets: PostOffset[] = [];
      if (baselines.length > 0) {
        for (const offset of input.postOffsets) {
          await tx`
            insert into jobs (type, payload, run_after)
            values ('start_scheduled_run',
              ${tx.json({ interventionId, offsetLabel: offset } as never)},
              greatest(
                (${input.shippedAt}::date + ${OFFSET_DAYS[offset]}::int)::timestamptz,
                now()))
          `;
          scheduledOffsets.push(offset);
        }
      }

      await writeAudit(tx, {
        userId: user.id,
        action: "intervention.create",
        entity: "intervention",
        entityId: interventionId,
        detail: {
          title: input.title,
          shippedAt: input.shippedAt,
          baselineWeak,
          baselines: baselines.length,
          scheduledOffsets,
        },
      });

      return {
        interventionId,
        baselineRunIds: baselines.map((b) => b.id as string),
        baselineWeak,
        scheduledOffsets,
      };
    });
    return ok(result);
  } catch (err) {
    return fail(err);
  }
}

/** Replace queued post-run jobs with the requested offset set (drafts only run once). */
export async function updateInterventionSchedule(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ interventionId: string; scheduledOffsets: PostOffset[] }>> {
  const parsed = z
    .object({
      interventionId: z.string().uuid(),
      postOffsets: z.array(z.enum(POST_OFFSETS)),
    })
    .safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "Invalid input."));
  }
  const { interventionId, postOffsets } = parsed.data;
  try {
    assertCanWrite(user);
    const result = await sql.begin(async (tx) => {
      const [intervention] = await tx`
        select shipped_at from interventions where id = ${interventionId}
      `;
      if (!intervention) throw new ClassifiedError("not_found", "Intervention not found.");
      await tx`
        delete from jobs
        where type = 'start_scheduled_run' and status = 'queued'
          and payload->>'interventionId' = ${interventionId}
      `;
      for (const offset of postOffsets) {
        await tx`
          insert into jobs (type, payload, run_after)
          values ('start_scheduled_run',
            ${tx.json({ interventionId, offsetLabel: offset } as never)},
            greatest(
              ((${intervention.shippedAt as string})::date + ${OFFSET_DAYS[offset]}::int)::timestamptz,
              now()))
        `;
      }
      await writeAudit(tx, {
        userId: user.id,
        action: "intervention.schedule",
        entity: "intervention",
        entityId: interventionId,
        detail: { postOffsets },
      });
      return { interventionId, scheduledOffsets: postOffsets };
    });
    return ok(result);
  } catch (err) {
    return fail(err);
  }
}

/**
 * Portal visibility (plan 4.1): interventions reach the client portal only
 * when an operator flips this deliberately — same deny-by-default rule as
 * tasks.client_visible (migration 031).
 */
export async function setInterventionVisibility(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ interventionId: string; clientVisible: boolean }>> {
  const parsed = z
    .object({ interventionId: z.string().uuid(), clientVisible: z.boolean() })
    .safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "Invalid input."));
  }
  const { interventionId, clientVisible } = parsed.data;
  try {
    assertCanWrite(user);
    await sql.begin(async (tx) => {
      const [row] = await tx`
        update interventions set client_visible = ${clientVisible}
        where id = ${interventionId} and archived_at is null
        returning id
      `;
      if (!row) throw new ClassifiedError("not_found", "Intervention not found.");
      await writeAudit(tx, {
        userId: user.id,
        action: "intervention.visibility",
        entity: "intervention",
        entityId: interventionId,
        detail: { clientVisible },
      });
    });
    return ok({ interventionId, clientVisible });
  } catch (err) {
    return fail(err);
  }
}

const statusActionSchema = z.discriminatedUnion("action", [
  z.object({
    interventionId: z.string().uuid(),
    action: z.literal("block"),
    reason: z.string().trim().min(1, "A reason is required to block.").max(500),
  }),
  z.object({ interventionId: z.string().uuid(), action: z.literal("unblock") }),
  z.object({
    interventionId: z.string().uuid(),
    action: z.literal("cancel"),
    reason: z.string().trim().max(500).optional(),
  }),
]);

/**
 * Operator lifecycle moves (spec 062): block with a reason, unblock back to
 * whatever the run history says is true, or cancel the measurement for the
 * record. Transition-validated and audit-logged; system moves (pending →
 * retested) belong to the sync, not here.
 */
export async function setInterventionStatus(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ interventionId: string; status: InterventionStatus }>> {
  const parsed = statusActionSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const input = parsed.data;
  try {
    assertCanWrite(user);
    const result = await sql.begin(async (tx) => {
      const [row] = await tx`
        select status from interventions
        where id = ${input.interventionId} and archived_at is null
        for update
      `;
      if (!row) throw new ClassifiedError("not_found", "Intervention not found.");
      const from = row.status as InterventionStatus;

      let to: InterventionStatus;
      if (input.action === "block") to = "blocked";
      else if (input.action === "cancel") to = "cancelled";
      else {
        const [history] = await tx`
          select
            exists (
              select 1 from intervention_runs ir join runs r on r.id = ir.run_id
              where ir.intervention_id = ${input.interventionId}
                and ir.role = 'post' and r.status in ('completed', 'partial')
            ) as has_completed_post,
            (exists (
              select 1 from intervention_runs ir
              where ir.intervention_id = ${input.interventionId} and ir.role = 'post'
            ) or exists (
              select 1 from jobs j
              where j.type = 'start_scheduled_run' and j.status = 'queued'
                and j.payload->>'interventionId' = ${input.interventionId}
            )) as has_pending_post
        `;
        to = deriveObservedStatus({
          hasCompletedPost: Boolean(history?.hasCompletedPost),
          hasPendingPost: Boolean(history?.hasPendingPost),
        });
      }

      if (!canTransition(from, to)) {
        throw new ClassifiedError(
          "validation",
          `Cannot move an intervention from ${from} to ${to}.`
        );
      }
      await tx`
        update interventions
        set status = ${to},
            blocked_reason = ${input.action === "block" ? input.reason : null},
            status_changed_at = now()
        where id = ${input.interventionId}
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "intervention.status",
        entity: "intervention",
        entityId: input.interventionId,
        detail: {
          from,
          to,
          reason: "reason" in input ? (input.reason ?? null) : null,
        },
      });
      return { interventionId: input.interventionId, status: to };
    });
    return ok(result);
  } catch (err) {
    return fail(err);
  }
}

/**
 * System sync (spec 062), ridden by the automation heartbeat next to the
 * outcome sweep: advance shipped/retest_pending rows to what the run history
 * already shows. Idempotent; never unblocks and never cancels — those are
 * human moves.
 */
export async function syncInterventionStatuses(): Promise<{ advanced: number }> {
  const rows = await sql`
    select i.id, i.status,
      exists (
        select 1 from intervention_runs ir join runs r on r.id = ir.run_id
        where ir.intervention_id = i.id and ir.role = 'post'
          and r.status in ('completed', 'partial')
      ) as has_completed_post,
      (exists (
        select 1 from intervention_runs ir
        where ir.intervention_id = i.id and ir.role = 'post'
      ) or exists (
        select 1 from jobs j
        where j.type = 'start_scheduled_run' and j.status = 'queued'
          and j.payload->>'interventionId' = i.id::text
      )) as has_pending_post
    from interventions i
    where i.archived_at is null and i.status in ('shipped', 'retest_pending')
  `;
  let advanced = 0;
  for (const row of rows) {
    const from = row.status as InterventionStatus;
    const observed = deriveObservedStatus({
      hasCompletedPost: Boolean(row.hasCompletedPost),
      hasPendingPost: Boolean(row.hasPendingPost),
    });
    if (observed === from || !canTransition(from, observed)) continue;
    await sql`
      update interventions
      set status = ${observed}, status_changed_at = now()
      where id = ${row.id} and status = ${from}
    `;
    advanced += 1;
    log("info", "attribution.status_synced", {
      interventionId: row.id,
      from,
      to: observed,
    });
  }
  return { advanced };
}

/** Worker handler: start the post run on the intervention's instrument. */
export async function startScheduledRun(payload: {
  interventionId: string;
  offsetLabel: string;
}): Promise<void> {
  const { interventionId, offsetLabel } = payload;
  const [intervention] = await sql`
    select i.id, i.project_id, i.title, i.prompt_set_version_id, i.archived_at
    from interventions i where i.id = ${interventionId}
  `;
  if (!intervention || intervention.archivedAt) {
    log("warn", "attribution.scheduled_run_skipped", { interventionId });
    return;
  }
  const [latestBaseline] = await sql`
    select r.providers, r.budget_usd from intervention_runs ir
    join runs r on r.id = ir.run_id
    where ir.intervention_id = ${interventionId} and ir.role = 'baseline'
    order by r.started_at desc limit 1
  `;
  if (!latestBaseline) {
    // A silently skipped retest is exactly the failure the attention queue
    // must see (spec 062): block with the reason instead of only logging.
    const from = (
      await sql`select status from interventions where id = ${interventionId}`
    )[0]?.status as InterventionStatus | undefined;
    if (from && canTransition(from, "blocked")) {
      await sql`
        update interventions
        set status = 'blocked',
            blocked_reason = 'Retest skipped: no baseline run to copy the instrument configuration from.',
            status_changed_at = now()
        where id = ${interventionId}
      `;
    }
    log("warn", "attribution.no_baseline_config", { interventionId });
    return;
  }
  const started = await startRun(
    null,
    {
      projectId: intervention.projectId as string,
      promptSetVersionId: intervention.promptSetVersionId as string,
      providers: latestBaseline.providers as ProviderConfig[],
      budgetUsd: Number(latestBaseline.budgetUsd),
      label: `${intervention.title as string} ${offsetLabel}`,
    },
    "scheduled"
  );
  if (!started.ok) {
    throw new ClassifiedError("internal", `Post run failed: ${started.error.message}`);
  }
  await sql`
    insert into intervention_runs (intervention_id, run_id, role, offset_label)
    values (${interventionId}, ${started.data.id}, 'post', ${offsetLabel})
  `;
  log("info", "attribution.post_run_started", {
    interventionId,
    offsetLabel,
    runId: started.data.id,
  });
}

/**
 * The subject's measured verdicts for one intervention ('all' provider),
 * in snapshot/portal-friendly shape (spec 051). Shared by the report
 * snapshot builder and the portal work tab — one derivation, two surfaces.
 */
export async function interventionVerdictSummaries(
  projectId: string,
  interventionId: string
): Promise<{ metric: string; postRunId: string; delta: number; verdict: string }[]> {
  const { getSubjectCompany } = await import("@/db/companies");
  const subject = await getSubjectCompany(projectId);
  if (!subject) return [];
  const scoreRows = await sql`
    select s.id as score_id, s.run_id, s.metric, s.provider, s.value,
      s.sample_size, s.scoring_version, ir.role
    from intervention_runs ir
    join scores s on s.run_id = ir.run_id
    where ir.intervention_id = ${interventionId} and s.company_id = ${subject.id}
  `;
  const toInput = (r: (typeof scoreRows)[number]): ScoreInput => ({
    scoreId: r.scoreId as string,
    runId: r.runId as string,
    metric: r.metric as string,
    provider: r.provider as string,
    value: Number(r.value),
    sampleSize: r.sampleSize as number,
    scoringVersion: r.scoringVersion as string,
  });
  return computeVerdicts(
    scoreRows.filter((r) => r.role === "baseline").map(toInput),
    scoreRows.filter((r) => r.role === "post").map(toInput)
  ).map((v) => ({
    metric: v.metric,
    postRunId: v.postRunId,
    delta: v.delta,
    verdict: v.verdict ?? "not_comparable",
  }));
}

export interface PostRunComparability {
  runId: string;
  offsetLabel: string | null;
  grade: ComparabilityGrade;
  reasons: string[];
}

export interface InterventionView {
  verdicts: MetricVerdict[];
  /** Graded instrument comparability per post run (spec 062) — replaces the
   * old boolean instrumentChanged flag with an explainable read. */
  comparability: PostRunComparability[];
  confoundedWith: { id: string; title: string }[];
  /** Latest live-verification result per shipped URL (spec 051). */
  urlChecks: import("@/lib/attribution/verify-urls").UrlCheck[];
  /** The subject's model-agreement read (spec 066) on the latest completed
   * post run (spec 067) — whether the post-retest state is consistent
   * across assistants. Null until a post run completes. */
  postRunAgreement: {
    offsetLabel: string | null;
    label: import("@/lib/competitors/agreement").AgreementLabel;
    summary: string;
  } | null;
}

/** Verdicts + flags, computed on read for the self company (never stored). */
export async function interventionView(
  interventionId: string
): Promise<InterventionView> {
  const [intervention] = await sql`
    select id, project_id, prompt_set_version_id, shipped_at
    from interventions where id = ${interventionId}
  `;
  if (!intervention) {
    throw new ClassifiedError("not_found", "Intervention not found.");
  }

  const { getSubjectCompany } = await import("@/db/companies");
  const subject = await getSubjectCompany(intervention.projectId as string);
  const scoreRows = subject
    ? await sql`
        select s.id as score_id, s.run_id, s.metric, s.provider, s.value,
          s.sample_size, s.scoring_version, ir.role
        from intervention_runs ir
        join scores s on s.run_id = ir.run_id
        where ir.intervention_id = ${interventionId}
          and s.company_id = ${subject.id}
      `
    : [];
  const toInput = (r: (typeof scoreRows)[number]): ScoreInput => ({
    scoreId: r.scoreId as string,
    runId: r.runId as string,
    metric: r.metric as string,
    provider: r.provider as string,
    value: Number(r.value),
    sampleSize: r.sampleSize as number,
    scoringVersion: r.scoringVersion as string,
  });
  const verdicts = computeVerdicts(
    scoreRows.filter((r) => r.role === "baseline").map(toInput),
    scoreRows.filter((r) => r.role === "post").map(toInput)
  );

  // Graded comparability (spec 062): compose the instrument facts the runs
  // already carry — provider set, models, repetitions, prompt version,
  // scoring versions — into an explainable grade per post run.
  const instruments = await sql`
    select ir.role, ir.offset_label, r.id, r.providers, r.prompt_set_version_id,
      coalesce(
        array_agg(distinct s.scoring_version)
          filter (where s.scoring_version is not null),
        '{}'
      ) as scoring_versions
    from intervention_runs ir
    join runs r on r.id = ir.run_id
    left join scores s on s.run_id = r.id
    where ir.intervention_id = ${interventionId}
    group by ir.role, ir.offset_label, r.id, r.providers,
      r.prompt_set_version_id, r.started_at
    order by r.started_at desc
  `;
  const toSnapshot = (r: (typeof instruments)[number]): InstrumentSnapshot => ({
    runId: r.id as string,
    promptSetVersionId: r.promptSetVersionId as string,
    providers: r.providers as ProviderConfig[],
    scoringVersions: r.scoringVersions as string[],
  });
  const baselineSnapshots = instruments
    .filter((r) => r.role === "baseline")
    .map(toSnapshot);
  const comparability: PostRunComparability[] = instruments
    .filter((r) => r.role === "post")
    .map((r) => {
      const assessment = assessComparability(baselineSnapshots, toSnapshot(r));
      return {
        runId: r.id as string,
        offsetLabel: (r.offsetLabel as string | null) ?? null,
        grade: assessment.grade,
        reasons: assessment.reasons,
      };
    });

  const others = await sql`
    select id, title, shipped_at from interventions
    where prompt_set_version_id = ${intervention.promptSetVersionId}
      and id != ${interventionId} and archived_at is null
  `;
  const confoundedWith = others
    .filter((o) =>
      windowsOverlap(
        intervention.shippedAt as string,
        o.shippedAt as string
      )
    )
    .map((o) => ({ id: o.id as string, title: o.title as string }));

  const { latestUrlChecks } = await import("@/lib/attribution/verify-urls");
  const urlChecks = await latestUrlChecks(interventionId);

  // Post-run agreement (spec 067): the subject's spec-066 read on the
  // latest completed post run — one loader call, derived on read.
  let postRunAgreement: InterventionView["postRunAgreement"] = null;
  const [latestPost] = await sql`
    select r.id, ir.offset_label from intervention_runs ir
    join runs r on r.id = ir.run_id
    where ir.intervention_id = ${interventionId} and ir.role = 'post'
      and r.status in ('completed', 'partial')
    order by r.started_at desc limit 1
  `;
  if (latestPost) {
    const { modelAgreementForProject } = await import("@/lib/competitors/agreement");
    const agreement = await modelAgreementForProject(
      intervention.projectId as string,
      latestPost.id as string
    );
    const selfRow = agreement.rows.find((r) => r.isSelf);
    if (selfRow) {
      postRunAgreement = {
        offsetLabel: (latestPost.offsetLabel as string | null) ?? null,
        label: selfRow.label,
        summary: selfRow.summary,
      };
    }
  }

  return { verdicts, comparability, confoundedWith, urlChecks, postRunAgreement };
}
