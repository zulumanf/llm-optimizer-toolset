/**
 * The platform's clock, as a library (2026-08-17).
 *
 * One implementation of "what a scheduler tick does", shared by every caller:
 * the worker's internal ticker (the primary clock now that the app has an
 * always-on process) and the /api/cron/* routes (kept for manual pokes and
 * any external scheduler). Everything in here is idempotent and windowed —
 * safe at any frequency, from any number of callers, concurrently; see the
 * per-section notes. A failure in any side-section must never fail trigger
 * dispatch or event delivery, which are the time-critical core.
 */
import { runEventDelivery, runTriggerDispatch } from "@/lib/automation/dispatch";
import { sweepConnections } from "@/lib/connectors/health";
import {
  runDailyMaintenance,
  runWeeklyMaintenance,
} from "@/lib/knowledge/maintenance/service";
import { measureDueActionOutcomes } from "@/lib/outcomes/sweep";
import { startWeeklyBriefs, startWeeklyCycles } from "@/lib/cycles/service";
import { syncNotifications } from "@/lib/notifications/service";
import { log } from "@/lib/logger";

export interface AutomationTickReport {
  triggers: { evaluated: number; fired: number; skipped: number; failed: number };
  events: Record<string, unknown>;
  health: Record<string, unknown>;
  maintenance: Record<string, unknown>;
  drift: Record<string, unknown>;
  alerts: Record<string, unknown>;
  outcomes: Record<string, unknown>;
  notifications: Record<string, unknown>;
  scheduledSends: Record<string, unknown>;
}

/**
 * The automation heartbeat: due schedules and thresholds fire, undelivered
 * events are swept, maintenance/drift/alerts/outcomes ride along. Health
 * probes cost real provider calls, so they run only when asked
 * (`includeHealth`) — callers give them a daily cadence.
 */
export async function runAutomationTick(
  opts: { includeHealth?: boolean } = {}
): Promise<AutomationTickReport> {
  // Prospect enrichment sweep (spec 081) rides the DAILY cadence only —
  // and is self-limiting beyond that: per-prospect freshness windows mean
  // zero API calls until something is 30 days stale. Staged proposals
  // only; every approval stays human (PRINCIPLES #8). Isolated: a sweep
  // failure must never fail dispatch.
  // Evidence-link health (2026-08-19) rides the daily lane too: receipts on
  // LIVE audits get re-fetched weekly (staleness window inside the sweep),
  // so a moved or dead source link becomes a known state instead of a
  // silently-healthy render. Isolated: a sweep failure never fails dispatch.
  if (opts.includeHealth) {
    try {
      const { sweepEvidenceLinks } = await import("@/lib/evidence/link-health");
      await sweepEvidenceLinks();
    } catch (err) {
      log("error", "cron.evidence_link_sweep_failed", {
        error: err instanceof Error ? err.message : "unknown",
      });
    }
  }
  if (opts.includeHealth) {
    try {
      const { systemUser } = await import("@/lib/auth");
      const { sweepEnrichment } = await import("@/lib/prospects/enrichment");
      const { sql: db } = await import("@/db/client");
      const system = await systemUser();
      const launches = await db`
        select id from market_launches where archived_at is null
      `;
      for (const launch of launches) {
        await sweepEnrichment(system, { launchId: launch.id as string });
      }
    } catch (err) {
      log("error", "cron.enrichment_sweep_failed", {
        error: err instanceof Error ? err.message : "unknown",
      });
    }
  }
  const triggers = await runTriggerDispatch();
  const events = await runEventDelivery(100);
  const health = opts.includeHealth
    ? await sweepConnections()
    : { checked: 0, healthy: 0, failing: 0, expiringSoon: 0 };

  // Knowledge maintenance rides the same heartbeat rather than bringing its
  // own scheduler (spec 025); unique (kind, window_key) makes any cadence
  // safe. Drift detection (spec 053) and system alerts (spec 059) likewise
  // dedupe on their own keys.
  let drift: Record<string, unknown> = { skipped: true };
  try {
    const { detectDriftSignals } = await import("@/lib/drift/detect");
    drift = { ...(await detectDriftSignals()) };
  } catch (err) {
    drift = { error: err instanceof Error ? err.message : "unknown" };
  }

  let alerts: Record<string, unknown> = { skipped: true };
  try {
    const { dispatchSystemAlerts } = await import("@/lib/ops/alerts");
    const result = await dispatchSystemAlerts();
    alerts = { firing: result.firing.map((a) => a.kind), sent: result.sent };
  } catch (err) {
    alerts = { error: err instanceof Error ? err.message : "unknown" };
  }

  let maintenance: Record<string, unknown> = { skipped: true };
  try {
    const daily = await runDailyMaintenance();
    const weekly = await runWeeklyMaintenance();
    maintenance = {
      daily: {
        windowKey: daily.windowKey,
        ranNow: !daily.alreadyRan,
        status: daily.status,
        exceptionsOpened: daily.exceptionsOpened,
        pagesRebuilt: daily.pagesRebuilt,
        pagesConsidered: daily.pagesConsidered,
      },
      weekly: {
        windowKey: weekly.windowKey,
        ranNow: !weekly.alreadyRan,
        status: weekly.status,
        exceptionsOpened: weekly.exceptionsOpened,
      },
    };
    if (daily.status === "partial" || weekly.status === "partial") {
      log("warn", "cron.maintenance.partial", {
        dailyFailed: daily.checksFailed,
        weeklyFailed: weekly.checksFailed,
      });
    }
  } catch (err) {
    log("error", "cron.maintenance_failed", {
      error: err instanceof Error ? err.message : "unknown",
    });
    maintenance = { error: "maintenance failed; dispatch was unaffected" };
  }

  // Outcome measurement (spec 034): write-once behind FOR UPDATE, so any
  // number of concurrent ticks measure each due outcome exactly once.
  let outcomes: Record<string, unknown> = { skipped: true };
  try {
    outcomes = { ...(await measureDueActionOutcomes()) };
  } catch (err) {
    log("error", "cron.outcome_measurement_failed", {
      error: err instanceof Error ? err.message : "unknown",
    });
    outcomes = { error: "outcome measurement failed; dispatch was unaffected" };
  }

  // Intervention status sync (spec 062): idempotent forward-only moves.
  try {
    const { syncInterventionStatuses } = await import("@/lib/attribution/service");
    const sync = await syncInterventionStatuses();
    outcomes = { ...outcomes, interventionStatusesAdvanced: sync.advanced };
  } catch (err) {
    log("error", "cron.intervention_status_sync_failed", {
      error: err instanceof Error ? err.message : "unknown",
    });
  }

  // Scheduled prospect sends (spec 091): transmit approved drafts whose
  // human-named send time has arrived, through the same gated entry point a
  // human click uses. Claim-marked and windowed — safe at any frequency,
  // from any number of ticks. Isolated: a drain failure never fails dispatch.
  let scheduledSends: Record<string, unknown> = { skipped: true };
  try {
    const { drainScheduledSends } = await import("@/lib/prospects/scheduled-sends");
    scheduledSends = { ...(await drainScheduledSends()) };
  } catch (err) {
    log("error", "cron.scheduled_sends_failed", {
      error: err instanceof Error ? err.message : "unknown",
    });
    scheduledSends = { error: "scheduled-send drain failed; dispatch was unaffected" };
  }

  // Notification sync (docs/17 B2): derives the operator inbox from platform
  // state. It had no production scheduler at all once launchd retired — the
  // worker tick is what actually runs it now. Idempotent; isolated.
  let notifications: Record<string, unknown> = { skipped: true };
  try {
    notifications = { ...(await syncNotifications()) };
  } catch (err) {
    log("error", "cron.notifications_failed", {
      error: err instanceof Error ? err.message : "unknown",
    });
    notifications = { error: "notification sync failed; dispatch was unaffected" };
  }

  if ((events.deadLettered as number) > 0 || triggers.failed > 0 || (health.failing as number) > 0) {
    log("warn", "cron.automation.degraded", {
      deadLettered: events.deadLettered,
      failedTriggers: triggers.failed,
      failingConnectors: health.failing,
    });
  }

  return {
    triggers: {
      evaluated: triggers.evaluated,
      fired: triggers.fired,
      skipped: triggers.skipped,
      failed: triggers.failed,
    },
    events: events as unknown as Record<string, unknown>,
    health: opts.includeHealth
      ? {
          checked: health.checked,
          healthy: health.healthy,
          failing: health.failing,
          expiringSoon: health.expiringSoon,
        }
      : { skipped: true },
    maintenance,
    drift,
    alerts,
    outcomes,
    notifications,
    scheduledSends,
  };
}

/**
 * The weekly kickoff (spec 017): start each configured project's weekly
 * cycle and brief. Idempotent per ISO week — a repeat fire is a no-op, so
 * any tick after the week rolls over starts the week's work.
 *
 * `startWeeklyCycles` serves CLIENT projects only (a cycle is client
 * machinery), so the standalone baseline sweep below is what runs enrolled
 * non-client projects — the prospect market benchmarks (spec 075's feed).
 * Discovered on the worker clock's first production tick (2026-08-17): the
 * weekly-baseline route had had NO caller since launchd retired, so an
 * enrolled prospect project's weekly run silently never started.
 */
export async function runWeeklyKick(): Promise<Record<string, unknown>> {
  const cycles = await startWeeklyCycles();
  const briefs = await startWeeklyBriefs();
  const baselines = await runWeeklyBaselines();
  return { ...cycles, briefs, baselines };
}

interface BaselineConfig {
  providers: import("@/lib/runs/cells").ProviderConfig[];
  budgetUsd: number;
}

/**
 * Weekly baseline sweep (docs/07 cadence; formerly only the
 * /api/cron/weekly-baseline route): for each active project of ANY kind
 * with a configured baseline set, start a scheduled run of the latest
 * frozen version — unless one already exists for this ISO week (UTC).
 * Windowed and idempotent like everything else on the tick.
 */
export async function runWeeklyBaselines(): Promise<
  Array<{ projectId: string; outcome: string }>
> {
  const { startRun } = await import("@/lib/runs/service");
  const { sql } = await import("@/db/client");

  const projects = await sql`
    select id, name, baseline_prompt_set_id, baseline_config
    from projects
    where status = 'active' and baseline_prompt_set_id is not null
  `;

  const results: Array<{ projectId: string; outcome: string }> = [];
  for (const project of projects) {
    const projectId = project.id as string;
    const config = project.baselineConfig as BaselineConfig | null;
    if (!config?.providers?.length || !config.budgetUsd) {
      log("warn", "cron.baseline.misconfigured", { projectId });
      results.push({ projectId, outcome: "misconfigured" });
      continue;
    }

    const [latest] = await sql`
      select id from prompt_set_versions
      where prompt_set_id = ${project.baselinePromptSetId as string}
      order by version desc limit 1
    `;
    if (!latest) {
      log("warn", "cron.baseline.never_frozen", { projectId });
      results.push({ projectId, outcome: "never_frozen" });
      continue;
    }

    // Dedupe key: ISO week (UTC) of started_at for scheduled runs
    const [existing] = await sql`
      select id from runs
      where project_id = ${projectId} and trigger = 'scheduled'
        and to_char(started_at at time zone 'UTC', 'IYYY-IW')
          = to_char(now() at time zone 'UTC', 'IYYY-IW')
    `;
    if (existing) {
      results.push({ projectId, outcome: "already_ran_this_week" });
      continue;
    }

    const week = new Date().toISOString().slice(0, 10);
    const started = await startRun(
      null,
      {
        projectId,
        promptSetVersionId: latest.id as string,
        providers: config.providers,
        budgetUsd: config.budgetUsd,
        label: `Weekly baseline ${week}`,
      },
      "scheduled"
    );
    if (started.ok) {
      log("info", "cron.baseline.started", { projectId, runId: started.data.id });
      results.push({ projectId, outcome: "started" });
    } else {
      log("error", "cron.baseline.failed", {
        projectId,
        error: started.error.message,
      });
      results.push({ projectId, outcome: `failed: ${started.error.kind}` });
    }
  }
  return results;
}

/** Pure cadence check for the worker loop — known-answer testable. */
export function tickDue(lastTickAt: number | null, now: number, intervalMs: number): boolean {
  if (lastTickAt === null) return true;
  return now - lastTickAt >= intervalMs;
}
