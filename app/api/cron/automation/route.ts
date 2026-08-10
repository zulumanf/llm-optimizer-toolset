/**
 * The automation heartbeat. Point a per-minute scheduler here and the whole
 * layer runs: due schedules and thresholds fire, undelivered events are swept,
 * and connector health is probed on its own slower cadence.
 *
 * Safe to call at any frequency, from any number of schedulers. That safety is
 * structural, not conventional: a trigger's fire key is the *window's* identity,
 * so two callers racing on the same 09:00 slot produce exactly one run, and
 * event delivery is keyed on (event, subscription) so a re-sweep cannot start a
 * second run of the same work.
 */
import { NextResponse } from "next/server";
import { runEventDelivery, runTriggerDispatch } from "@/lib/automation/dispatch";
import { sweepConnections } from "@/lib/connectors/health";
import {
  runDailyMaintenance,
  runWeeklyMaintenance,
} from "@/lib/knowledge/maintenance/service";
import { measureDueActionOutcomes } from "@/lib/outcomes/sweep";
import { requireCronSecret } from "@/lib/security/cron-auth";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  // Refuse rather than run open. An unauthenticated automation heartbeat is a
  // way for anyone to make the platform act.
  const denied = requireCronSecret(request);
  if (denied) return denied;

  const url = new URL(request.url);
  // Health probes cost real provider calls, so they run on their own cadence
  // rather than every minute.
  const includeHealth = url.searchParams.get("health") === "true";

  try {
    const triggers = await runTriggerDispatch();
    const events = await runEventDelivery(100);
    const health = includeHealth
      ? await sweepConnections()
      : { checked: 0, healthy: 0, failing: 0, expiringSoon: 0 };

    // Knowledge maintenance rides the same heartbeat rather than bringing its
    // own scheduler (spec 025). Calling it every minute is safe and cheap: the
    // unique (kind, window_key) index means the first caller in a window does
    // the work and every other caller returns that run untouched. A failure
    // here must not fail the heartbeat, because trigger dispatch and event
    // delivery are more time-critical than reconciliation.
    // Drift detection rides the heartbeat (spec 053): open signals dedupe,
    // so any cadence is safe, and a detector failure must never fail
    // trigger dispatch.
    let drift: Record<string, unknown> = { skipped: true };
    try {
      const { detectDriftSignals } = await import("@/lib/drift/detect");
      drift = { ...(await detectDriftSignals()) };
    } catch (err) {
      drift = { error: err instanceof Error ? err.message : "unknown" };
    }

    // System alerts (spec 059): deterministic thresholds over the health
    // report, deduped per kind. A failure here must never fail dispatch.
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

    // Outcome measurement rides the heartbeat too (spec 034). Idempotent by
    // construction: measureAction is write-once behind FOR UPDATE, so any
    // number of concurrent heartbeats measure each due outcome exactly once.
    // Isolated like maintenance — a measurement failure must not fail dispatch.
    let outcomes: Record<string, unknown> = { skipped: true };
    try {
      outcomes = { ...(await measureDueActionOutcomes()) };
    } catch (err) {
      log("error", "cron.outcome_measurement_failed", {
        error: err instanceof Error ? err.message : "unknown",
      });
      outcomes = { error: "outcome measurement failed; dispatch was unaffected" };
    }

    if (events.deadLettered > 0 || triggers.failed > 0 || health.failing > 0) {
      log("warn", "cron.automation.degraded", {
        deadLettered: events.deadLettered,
        failedTriggers: triggers.failed,
        failingConnectors: health.failing,
      });
    }

    return NextResponse.json({
      triggers: {
        evaluated: triggers.evaluated,
        fired: triggers.fired,
        skipped: triggers.skipped,
        failed: triggers.failed,
      },
      events,
      health: includeHealth
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
    });
  } catch (err) {
    log("error", "cron.automation_failed", {
      error: err instanceof Error ? err.message : "unknown",
    });
    return NextResponse.json({ error: "Automation dispatch failed" }, { status: 500 });
  }
}
