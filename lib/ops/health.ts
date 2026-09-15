/**
 * Operational health (spec 059). One deterministic report answering the
 * questions the audit found unanswerable: is the worker alive, is the
 * queue moving, is the instrument drifting, is spend approaching the
 * ceiling. Pure reads — safe on any cadence.
 */
import { sql } from "@/db/client";
import { DAILY_SPEND_CEILING_USD } from "@/lib/constants";
import { spendLast24hUsd } from "@/db/runs";

/** A worker that hasn't beaten in this long is presumed dead. The poll
 * cycle is 2s; 120s tolerates GC pauses, deploys, and long single jobs
 * between beats without tolerating an actual crash for long. */
export const WORKER_STALE_SECONDS = 120;
/** A queued job this old means nothing is draining the queue. */
export const QUEUE_ALERT_MINUTES = 15;
/** Alert when 24h spend crosses this share of the daily ceiling. */
export const SPEND_ALERT_SHARE = 0.9;

export interface HealthReport {
  ok: boolean;
  db: boolean;
  worker: {
    alive: boolean;
    lastSeenAt: Date | null;
    workerId: string | null;
  };
  queue: {
    queued: number;
    oldestQueuedMinutes: number | null;
    overdue: number;
  };
  drift: { openSignals: number };
  spend: { last24hUsd: number; ceilingUsd: number };
}

export async function healthReport(): Promise<HealthReport> {
  const report: HealthReport = {
    ok: false,
    db: false,
    worker: { alive: false, lastSeenAt: null, workerId: null },
    queue: { queued: 0, oldestQueuedMinutes: null, overdue: 0 },
    drift: { openSignals: 0 },
    spend: { last24hUsd: 0, ceilingUsd: DAILY_SPEND_CEILING_USD },
  };
  try {
    const [beat] = await sql`
      select worker_id, last_seen_at from worker_heartbeats
      order by last_seen_at desc limit 1
    `;
    report.db = true;
    if (beat) {
      report.worker.workerId = beat.workerId as string;
      report.worker.lastSeenAt = beat.lastSeenAt as Date;
      report.worker.alive =
        Date.now() - (beat.lastSeenAt as Date).getTime() <
        WORKER_STALE_SECONDS * 1000;
    }
    const [queue] = await sql`
      select count(*)::int as queued,
        extract(epoch from (now() - min(created_at))) / 60 as oldest_minutes,
        count(*) filter (where run_after < now() - make_interval(
          mins => ${QUEUE_ALERT_MINUTES}))::int as overdue
      from jobs where status = 'queued'
    `;
    report.queue.queued = Number(queue?.queued ?? 0);
    report.queue.oldestQueuedMinutes =
      queue?.oldestMinutes === null || queue?.oldestMinutes === undefined
        ? null
        : Math.round(Number(queue.oldestMinutes));
    report.queue.overdue = Number(queue?.overdue ?? 0);
    const [drift] = await sql`
      select count(*)::int as n from drift_signals where status = 'open'
    `;
    report.drift.openSignals = Number(drift?.n ?? 0);
    report.spend.last24hUsd = Number((await spendLast24hUsd()).toFixed(4));
  } catch {
    // db stays false; the report itself is the diagnosis.
    return report;
  }
  report.ok = report.db && report.worker.alive;
  return report;
}

/** The worker's pulse. Called every poll cycle; an upsert is cheap. */
export interface WorkerIdentity {
  /** Commit the running image was built from (BUILD_COMMIT / RAILWAY_GIT_COMMIT_SHA), or null when unknown. */
  version: string | null;
  /** Job types this worker can execute — deployment QA reads it from the row. */
  handlers: string[];
}

export async function beatHeartbeat(
  workerId: string,
  jobsProcessed: number,
  identity: WorkerIdentity = { version: null, handlers: [] }
): Promise<void> {
  await sql`
    insert into worker_heartbeats (worker_id, last_seen_at, jobs_processed, version, handlers)
    values (${workerId}, now(), ${jobsProcessed}, ${identity.version}, ${identity.handlers})
    on conflict (worker_id) do update
      set last_seen_at = now(), jobs_processed = ${jobsProcessed},
          version = ${identity.version}, handlers = ${identity.handlers}
  `;
}

/** Commit identity of this process, from the deploy-time variable. */
export function runningVersion(): string | null {
  return process.env.BUILD_COMMIT ?? process.env.RAILWAY_GIT_COMMIT_SHA ?? null;
}
