/**
 * Interventions (spec 007, docs/07): record what shipped, tie it to baseline
 * runs of a frozen version, schedule post re-runs (+2/+6/+12w) on the same
 * instrument, and compute verdicts on read. Overlapping interventions on the
 * same version are mutually flagged confounded — no silent averaging.
 */
import { z } from "zod";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import type { CurrentUser } from "@/lib/auth";
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
import type { ProviderConfig } from "@/lib/runs/cells";
import { log } from "@/lib/logger";

export const POST_OFFSETS = ["+2w", "+6w", "+12w"] as const;
export type PostOffset = (typeof POST_OFFSETS)[number];
const OFFSET_DAYS: Record<PostOffset, number> = { "+2w": 14, "+6w": 42, "+12w": 84 };

const createSchema = z.object({
  projectId: z.string().uuid(),
  title: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(1, "Title is required.").max(120)),
  description: z.string().max(2000).optional(),
  shippedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  urls: z.array(z.string().url()).max(10).default([]),
  promptSetVersionId: z.string().uuid(),
  taskId: z.string().uuid().optional(),
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

      const [row] = await tx`
        insert into interventions
          (project_id, title, description, shipped_at, urls,
           prompt_set_version_id, task_id, baseline_weak, created_by)
        values
          (${input.projectId}, ${input.title}, ${input.description ?? null},
           ${input.shippedAt}, ${input.urls}, ${input.promptSetVersionId},
           ${input.taskId ?? null}, ${baselineWeak}, ${user.id})
        returning id
      `;
      const interventionId = row?.id as string;

      for (const baseline of baselines) {
        await tx`
          insert into intervention_runs (intervention_id, run_id, role)
          values (${interventionId}, ${baseline.id}, 'baseline')
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

export interface InterventionView {
  verdicts: MetricVerdict[];
  instrumentChanged: boolean;
  confoundedWith: { id: string; title: string }[];
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

  const scoreRows = await sql`
    select s.id as score_id, s.run_id, s.metric, s.provider, s.value,
      s.sample_size, s.scoring_version, ir.role
    from intervention_runs ir
    join scores s on s.run_id = ir.run_id
    join companies c on c.id = s.company_id
    where ir.intervention_id = ${interventionId} and c.is_self
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
  const verdicts = computeVerdicts(
    scoreRows.filter((r) => r.role === "baseline").map(toInput),
    scoreRows.filter((r) => r.role === "post").map(toInput)
  );

  // Instrument change: any post run whose provider config differs from the
  // latest baseline's (model retired mid-experiment, config drift)
  const configs = await sql`
    select ir.role, r.providers from intervention_runs ir
    join runs r on r.id = ir.run_id
    where ir.intervention_id = ${interventionId}
    order by r.started_at desc
  `;
  const baselineConfig = JSON.stringify(
    configs.find((c) => c.role === "baseline")?.providers ?? null
  );
  const instrumentChanged = configs
    .filter((c) => c.role === "post")
    .some((c) => JSON.stringify(c.providers) !== baselineConfig);

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

  return { verdicts, instrumentChanged, confoundedWith };
}
