/**
 * System alerting (spec 059). Deterministic thresholds over the health
 * report, posted to DIGEST_WEBHOOK_URL and deduped per alert kind — the
 * audit's "worker.crashed goes to a terminal nobody is watching" closed.
 * An alarm that cries constantly is an alarm nobody hears, so each kind
 * posts once per window and re-arms.
 */
import { sql } from "@/db/client";
import {
  healthReport,
  SPEND_ALERT_SHARE,
  QUEUE_ALERT_MINUTES,
  type HealthReport,
} from "@/lib/ops/health";
import { log } from "@/lib/logger";

export const ALERT_RESEND_MINUTES = 60;

export interface SystemAlert {
  kind: string;
  message: string;
}

/** Pure: thresholds → alerts. Unit-testable without a database. */
export function alertsFromReport(report: HealthReport): SystemAlert[] {
  const alerts: SystemAlert[] = [];
  if (!report.db) {
    return [{ kind: "db_unreachable", message: "The database is unreachable." }];
  }
  if (!report.worker.alive) {
    alerts.push({
      kind: "worker_stale",
      message: report.worker.lastSeenAt
        ? `The worker has not beaten since ${report.worker.lastSeenAt.toISOString()} — everything asynchronous is stalled.`
        : "No worker has ever beaten — runs, parsing, and scoring will queue forever.",
    });
  }
  if (report.queue.overdue > 0) {
    alerts.push({
      kind: "queue_backlog",
      message: `${report.queue.overdue} queued job(s) are more than ${QUEUE_ALERT_MINUTES} minutes overdue (oldest ${report.queue.oldestQueuedMinutes ?? "?"}m).`,
    });
  }
  if (report.drift.openSignals > 0) {
    alerts.push({
      kind: "drift_open",
      message: `${report.drift.openSignals} open drift signal(s) — client deltas are suspect until acknowledged.`,
    });
  }
  if (report.spend.last24hUsd >= report.spend.ceilingUsd * SPEND_ALERT_SHARE) {
    alerts.push({
      kind: "spend_near_ceiling",
      message: `24h LLM spend $${report.spend.last24hUsd.toFixed(2)} is at ${Math.round((report.spend.last24hUsd / report.spend.ceilingUsd) * 100)}% of the $${report.spend.ceilingUsd} ceiling.`,
    });
  }
  return alerts;
}

/**
 * Evaluate, dedupe, and post. Returns what fired and what was actually
 * sent this tick. Without a webhook configured the alerts still return
 * (the cron response carries them) — silence is never silent failure.
 */
export async function dispatchSystemAlerts(deps?: {
  fetchImpl?: typeof fetch;
}): Promise<{ firing: SystemAlert[]; sent: string[] }> {
  const report = await healthReport();
  const firing = alertsFromReport(report);
  if (firing.length === 0) return { firing, sent: [] };

  const sent: string[] = [];
  for (const alert of firing) {
    const rows = await sql`
      insert into ops_alerts (kind, last_sent_at, last_message)
      values (${alert.kind}, now(), ${alert.message})
      on conflict (kind) do update
        set last_sent_at = now(), last_message = ${alert.message}
        where ops_alerts.last_sent_at < now() - make_interval(
          mins => ${ALERT_RESEND_MINUTES})
      returning kind
    `;
    if (rows.length === 0) continue; // inside the dedupe window
    sent.push(alert.kind);
    const webhook = process.env.DIGEST_WEBHOOK_URL;
    if (webhook) {
      try {
        await (deps?.fetchImpl ?? fetch)(webhook, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: `⚠️ [avos] ${alert.kind}: ${alert.message}` }),
        });
      } catch (err) {
        log("error", "ops.alert_webhook_failed", {
          kind: alert.kind,
          error: err instanceof Error ? err.message : "unknown",
        });
      }
    }
    log("warn", "ops.alert_fired", { kind: alert.kind, message: alert.message });
  }
  return { firing, sent };
}
