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
  };
}

/**
 * The weekly kickoff (spec 017): start each configured project's weekly
 * cycle and brief. Idempotent per ISO week — a repeat fire is a no-op, so
 * any tick after the week rolls over starts the week's work.
 */
export async function runWeeklyKick(): Promise<Record<string, unknown>> {
  const cycles = await startWeeklyCycles();
  const briefs = await startWeeklyBriefs();
  return { ...cycles, briefs };
}

/** Pure cadence check for the worker loop — known-answer testable. */
export function tickDue(lastTickAt: number | null, now: number, intervalMs: number): boolean {
  if (lastTickAt === null) return true;
  return now - lastTickAt >= intervalMs;
}
