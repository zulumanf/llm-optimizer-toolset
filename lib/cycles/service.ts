/**
 * Weekly operating cycle (spec 017). A small, durable state machine driven
 * by a self-rescheduling job: it performs every mechanical step of the week
 * for every client, and **halts with a reason** wherever a human owes the
 * client a judgement.
 *
 * The contract, stated once because it governs every branch below:
 *   automate the work, stop at the judgement.
 * The cycle never confirms a classification, never publishes a report, never
 * approves a task. It gets everything ready and tells you what it needs.
 */
import { sql } from "@/db/client";
import { enqueueJob } from "@/db/jobs";
import { startRun } from "@/lib/runs/service";
import { pendingReviewCount } from "@/db/mentions";
import { analyzeRun } from "@/lib/gaps/service";
import { analyzeRunAccuracy } from "@/lib/accuracy/service";
import { generateReportDraft } from "@/lib/reports/service";
import { getSubjectCompany } from "@/db/companies";
import { systemUser } from "@/lib/auth";
import type { ProviderConfig } from "@/lib/runs/cells";
import { log } from "@/lib/logger";

/** How long to wait before re-checking async work (benchmark execution,
 * parsing, scoring). Long enough not to spin, short enough that a Monday
 * cycle finishes within the morning. */
const RECHECK_SECONDS = 120;

export type CycleState =
  | "started"
  | "running_benchmark"
  | "analyzing"
  | "drafting"
  | "completed"
  | "halted"
  | "failed";

/** Monday (UTC) of the current ISO week. */
export function weekStart(now = new Date()): string {
  const date = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  const day = date.getUTCDay() || 7; // Sunday = 7
  date.setUTCDate(date.getUTCDate() - (day - 1));
  return date.toISOString().slice(0, 10);
}

async function step(cycleId: string, note: string): Promise<void> {
  await sql`
    update cycle_runs
    set steps = steps || ${sql.json([{ at: new Date().toISOString(), note }] as never)},
        updated_at = now()
    where id = ${cycleId}
  `;
}

async function halt(cycleId: string, reason: string): Promise<void> {
  await sql`
    update cycle_runs set state = 'halted', halt_reason = ${reason},
      updated_at = now(), finished_at = now()
    where id = ${cycleId}
  `;
  await step(cycleId, `halted: ${reason}`);
  log("warn", "cycle.halted", { cycleId, reason });
}

async function moveTo(cycleId: string, state: CycleState): Promise<void> {
  await sql`
    update cycle_runs set state = ${state}, updated_at = now(),
      finished_at = case when ${state} in ('completed','failed') then now() else null end
    where id = ${cycleId}
  `;
  await step(cycleId, `→ ${state}`);
}

async function scheduleNextTick(cycleId: string, seconds = RECHECK_SECONDS): Promise<void> {
  await sql`
    insert into jobs (type, payload, run_after)
    values ('advance_cycle', ${sql.json({ cycleId } as never)},
      now() + make_interval(secs => ${seconds}))
  `;
}

export interface StartCyclesResult {
  started: string[];
  skipped: { projectId: string; reason: string }[];
}

/**
 * Start this week's cycle for every eligible client. Idempotent: the unique
 * (project, week) index means a second call the same week changes nothing.
 */
export async function startWeeklyCycles(): Promise<StartCyclesResult> {
  const week = weekStart();
  const projects = await sql`
    select id, name, baseline_prompt_set_id, baseline_config
    from projects where status = 'active' and kind = 'client'
  `;
  const started: string[] = [];
  const skipped: { projectId: string; reason: string }[] = [];

  for (const project of projects) {
    const projectId = project.id as string;
    if (!project.baselinePromptSetId) {
      skipped.push({ projectId, reason: "no baseline configured" });
      continue;
    }
    const [existing] = await sql`
      select id from cycle_runs
      where project_id = ${projectId} and week_start = ${week}
    `;
    if (existing) {
      skipped.push({ projectId, reason: "cycle already exists this week" });
      continue;
    }
    const [row] = await sql`
      insert into cycle_runs (project_id, week_start) values (${projectId}, ${week})
      on conflict (project_id, week_start) do nothing
      returning id
    `;
    if (!row) {
      skipped.push({ projectId, reason: "cycle already exists this week" });
      continue;
    }
    await step(row.id as string, "cycle created");
    await enqueueJob(sql, "advance_cycle", { cycleId: row.id as string });
    started.push(row.id as string);
  }

  log("info", "cycles.started", { week, started: started.length, skipped: skipped.length });
  return { started, skipped };
}

/**
 * Advance one cycle by a single step. Safe to call repeatedly and safe to
 * re-run after a crash — every branch checks the world before acting.
 */
export async function advanceCycle(cycleId: string): Promise<CycleState> {
  const [cycle] = await sql`
    select c.*, to_char(c.week_start, 'YYYY-MM-DD') as week_start,
      p.baseline_prompt_set_id, p.baseline_config, p.name as project_name
    from cycle_runs c join projects p on p.id = c.project_id
    where c.id = ${cycleId}
  `;
  if (!cycle) throw new Error(`Cycle ${cycleId} not found`);
  const state = cycle.state as CycleState;
  if (["completed", "halted", "failed"].includes(state)) return state;

  const projectId = cycle.projectId as string;
  const user = await systemUser();

  // --- started → launch the benchmark ---------------------------------
  if (state === "started") {
    const subject = await getSubjectCompany(projectId);
    if (!subject) {
      await halt(cycleId, "no subject company configured");
      return "halted";
    }
    const [latest] = await sql`
      select id from prompt_set_versions
      where prompt_set_id = ${cycle.baselinePromptSetId}
      order by version desc limit 1
    `;
    if (!latest) {
      await halt(cycleId, "baseline prompt set has never been frozen");
      return "halted";
    }
    const config = cycle.baselineConfig as {
      providers: ProviderConfig[];
      budgetUsd: number;
    } | null;
    if (!config?.providers?.length || !config.budgetUsd) {
      await halt(cycleId, "baseline configuration is incomplete");
      return "halted";
    }

    // Reuse this week's scheduled run if one already exists (the standalone
    // baseline cron may have started it) rather than double-spending.
    const [existingRun] = await sql`
      select id from runs
      where project_id = ${projectId} and trigger = 'scheduled'
        -- UTC-anchored: weekStart is a UTC Monday; a bare ::date cast would
        -- compare in the session timezone (see lib/reports/snapshot.ts).
        and started_at >= (${cycle.weekStart} || ' 00:00:00+00')::timestamptz
      order by started_at desc limit 1
    `;
    let runId = existingRun?.id as string | undefined;
    if (!runId) {
      const started = await startRun(
        null,
        {
          projectId,
          promptSetVersionId: latest.id as string,
          providers: config.providers,
          budgetUsd: config.budgetUsd,
          label: `Weekly baseline ${cycle.weekStart}`,
        },
        "scheduled"
      );
      if (!started.ok) {
        await halt(cycleId, `could not start benchmark: ${started.error.message}`);
        return "halted";
      }
      runId = started.data.id;
    }
    await sql`update cycle_runs set run_id = ${runId} where id = ${cycleId}`;
    await step(cycleId, `benchmark ${runId}`);
    await moveTo(cycleId, "running_benchmark");
    await scheduleNextTick(cycleId);
    return "running_benchmark";
  }

  // --- running_benchmark → wait for capture, parse, and scoring --------
  if (state === "running_benchmark") {
    const runId = cycle.runId as string;
    const [run] = await sql`select status from runs where id = ${runId}`;
    const runStatus = run?.status as string;

    if (runStatus === "queued" || runStatus === "running") {
      await scheduleNextTick(cycleId);
      return "running_benchmark";
    }
    if (runStatus === "failed") {
      await halt(cycleId, "benchmark run failed — investigate before reporting");
      return "halted";
    }
    if (runStatus === "partial") {
      // Reporting on a partial week without a human deciding is exactly the
      // kind of silent inaccuracy this system exists to prevent.
      await halt(cycleId, "benchmark completed partially — needs a human call");
      return "halted";
    }

    // Judgement gate: unreviewed classifications block scoring by design.
    const pending = await pendingReviewCount(runId);
    if (pending > 0) {
      await halt(
        cycleId,
        `${pending} classification(s) need review before scoring — the cycle will not decide for you`
      );
      return "halted";
    }

    const [scored] = await sql`
      select 1 from scores where run_id = ${runId} limit 1
    `;
    if (!scored) {
      // Parsing/scoring still in flight
      await scheduleNextTick(cycleId);
      return "running_benchmark";
    }

    await moveTo(cycleId, "analyzing");
    await scheduleNextTick(cycleId, 1);
    return "analyzing";
  }

  // --- analyzing → gaps + accuracy (both idempotent) -------------------
  if (state === "analyzing") {
    const runId = cycle.runId as string;
    const gaps = await analyzeRun(user, { runId });
    if (!gaps.ok) {
      await halt(cycleId, `gap analysis failed: ${gaps.error.message}`);
      return "halted";
    }
    await step(cycleId, `gap findings: ${gaps.data.findings}`);

    // Accuracy monitoring needs approved claims; a client without them is a
    // setup gap, not a failure — note it and carry on.
    const accuracy = await analyzeRunAccuracy(user, { runId });
    await step(
      cycleId,
      accuracy.ok
        ? `accuracy findings: ${accuracy.data.findings} (${accuracy.data.rejected} quotes rejected)`
        : `accuracy skipped: ${accuracy.error.message}`
    );

    await moveTo(cycleId, "drafting");
    await scheduleNextTick(cycleId, 1);
    return "drafting";
  }

  // --- drafting → weekly pulse DRAFT (never published) -----------------
  if (state === "drafting") {
    const periodEnd = new Date().toISOString().slice(0, 10);
    const draft = await generateReportDraft(user, {
      projectId,
      title: `Weekly pulse ${cycle.weekStart}`,
      kind: "weekly_pulse",
      periodStart: cycle.weekStart as string,
      periodEnd,
    });
    if (draft.ok) {
      await sql`
        update cycle_runs set report_id = ${draft.data.id} where id = ${cycleId}
      `;
      await step(cycleId, "weekly pulse drafted (awaiting your review)");
    } else {
      // A missing draft is worth knowing about but is not a failed week:
      // the analyses above already landed.
      await step(cycleId, `pulse not drafted: ${draft.error.message}`);
    }
    await moveTo(cycleId, "completed");
    log("info", "cycle.completed", { cycleId, projectId });
    return "completed";
  }

  return state;
}
