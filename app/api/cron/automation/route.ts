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
import { getEnv } from "@/lib/env";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const secret = getEnv().CRON_SECRET;
  if (!secret) {
    // Refuse rather than run open. An unauthenticated automation heartbeat is a
    // way for anyone to make the platform act.
    return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 503 });
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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
    });
  } catch (err) {
    log("error", "cron.automation_failed", {
      error: err instanceof Error ? err.message : "unknown",
    });
    return NextResponse.json({ error: "Automation dispatch failed" }, { status: 500 });
  }
}
