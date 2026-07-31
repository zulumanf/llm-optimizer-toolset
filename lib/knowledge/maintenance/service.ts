/**
 * The maintenance runner (spec 025).
 *
 * Two guarantees this module exists to enforce, both testable:
 *
 * 1. **It reconciles; it does not regenerate.** A daily job that rebuilds
 *    every page would hide the staleness it exists to detect, and would make
 *    the incremental build engine pointless. So rebuilds are limited to pages
 *    a detector actually flagged, and the run records `pagesConsidered` beside
 *    `pagesRebuilt` so the ratio is auditable rather than asserted.
 *
 * 2. **It is idempotent per window.** The heartbeat fires every minute. The
 *    unique index on (kind, window_key, project) means a day's reconciliation
 *    happens once; a second caller in the same window returns the first run
 *    instead of doing the work again.
 *
 * A detector that throws does not abort the run. One broken query must not
 * cost the operator every other finding — the run finishes, reports `partial`,
 * and names which checks failed.
 */
import { sql } from "@/db/client";
import { log } from "@/lib/logger";
import { compileAffected } from "@/lib/knowledge/build/planner";
import { DAILY_DETECTORS, type DetectorResult } from "@/lib/knowledge/maintenance/detectors";
import { WEEKLY_DETECTORS, measureUsefulness } from "@/lib/knowledge/maintenance/weekly";
import { scanProjectContradictions } from "@/lib/knowledge/contradictions/detect";
import {
  autoResolveKnowledgeExceptions,
  raiseKnowledgeException,
  type KnowledgeExceptionKind,
} from "@/lib/knowledge/maintenance/exceptions";

export interface MaintenanceRun {
  id: string;
  kind: "daily" | "weekly";
  windowKey: string;
  status: "running" | "completed" | "partial" | "failed";
  checksRun: number;
  checksFailed: number;
  exceptionsOpened: number;
  exceptionsResolved: number;
  pagesRebuilt: number;
  pagesConsidered: number;
  durationMs: number;
  /** Present when the window had already been reconciled. */
  alreadyRan: boolean;
  detail: Record<string, unknown>;
}

/** UTC day, e.g. `2026-07-30`. */
export function dailyWindowKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * ISO week, e.g. `2026-W31`. Deliberately ISO rather than "7 days ago": a
 * window keyed on elapsed time is not idempotent, because every caller
 * computes a slightly different window.
 */
export function weeklyWindowKey(now: Date): string {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

interface RunOptions {
  projectId?: string | null;
  now?: Date;
  /** Skip the rebuild step — used by tests asserting detection in isolation. */
  rebuild?: boolean;
}

/**
 * Claim the window. Returns null when another caller already has it, which is
 * the whole concurrency story: the unique index does the arbitration, not a
 * lock we would have to remember to take.
 */
async function claimWindow(
  kind: "daily" | "weekly",
  windowKey: string,
  projectId: string | null
): Promise<string | null> {
  const rows = await sql`
    insert into knowledge_maintenance_runs (kind, window_key, project_id)
    values (${kind}, ${windowKey}, ${projectId})
    on conflict do nothing
    returning id
  `;
  return rows.length > 0 ? (rows[0]!.id as string) : null;
}

async function existingRun(
  kind: "daily" | "weekly",
  windowKey: string,
  projectId: string | null
): Promise<MaintenanceRun> {
  const [row] = await sql`
    select * from knowledge_maintenance_runs
    where kind = ${kind} and window_key = ${windowKey}
      and coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid)
        = coalesce(${projectId}::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
  `;
  return {
    id: row!.id as string,
    kind,
    windowKey,
    status: row!.status as MaintenanceRun["status"],
    checksRun: Number(row!.checksRun ?? 0),
    checksFailed: Number(row!.checksFailed ?? 0),
    exceptionsOpened: Number(row!.exceptionsOpened ?? 0),
    exceptionsResolved: Number(row!.exceptionsResolved ?? 0),
    pagesRebuilt: Number(row!.pagesRebuilt ?? 0),
    pagesConsidered: Number(row!.pagesConsidered ?? 0),
    durationMs: Number(row!.durationMs ?? 0),
    alreadyRan: true,
    detail: (row!.detail as Record<string, unknown>) ?? {},
  };
}

/**
 * Apply one detector's findings: raise or refresh an exception per finding,
 * then auto-resolve any open exception of that kind whose subject no longer
 * qualifies. Both halves matter — a feed that cannot shrink is a feed nobody
 * trusts.
 */
async function applyFindings(
  result: DetectorResult,
  runId: string,
  projectId: string | null
): Promise<{ opened: number; resolved: number; slugs: string[] }> {
  let opened = 0;
  // Slugs, not ids: the build planner addresses pages by slug, and every
  // page-shaped finding carries its slug in `detail` for exactly this.
  const slugs: string[] = [];

  for (const finding of result.findings) {
    const raised = await sql.begin((tx) =>
      raiseKnowledgeException(tx, {
        projectId: finding.projectId ?? projectId,
        maintenanceRunId: runId,
        kind: result.kind as KnowledgeExceptionKind,
        severity: finding.severity,
        subjectType: finding.subjectType,
        subjectId: finding.subjectId,
        summary: finding.summary,
        detail: finding.detail,
        recommendedAction: finding.recommendedAction,
      })
    );
    if (raised.created) opened += 1;
    const slug = finding.detail?.slug;
    if (finding.subjectType === "wiki_page" && typeof slug === "string") {
      slugs.push(slug);
    }
  }

  const stillFailing = result.findings
    .map((f) => f.subjectId)
    .filter((id): id is string => Boolean(id));
  const resolved = await sql.begin((tx) =>
    autoResolveKnowledgeExceptions(tx, result.kind as KnowledgeExceptionKind, stillFailing)
  );

  return { opened, resolved, slugs };
}

async function finish(
  runId: string,
  status: MaintenanceRun["status"],
  totals: {
    checksRun: number;
    checksFailed: number;
    opened: number;
    resolved: number;
    rebuilt: number;
    considered: number;
    detail: Record<string, unknown>;
    startedAt: number;
  }
): Promise<void> {
  await sql`
    update knowledge_maintenance_runs set
      status = ${status},
      checks_run = ${totals.checksRun},
      checks_failed = ${totals.checksFailed},
      exceptions_opened = ${totals.opened},
      exceptions_resolved = ${totals.resolved},
      pages_rebuilt = ${totals.rebuilt},
      pages_considered = ${totals.considered},
      detail = ${sql.json(totals.detail as never)},
      finished_at = now(),
      duration_ms = ${Date.now() - totals.startedAt}
    where id = ${runId}
  `;
}

/**
 * Daily reconciliation. Safe to call at any frequency from any number of
 * callers.
 */
export async function runDailyMaintenance(options: RunOptions = {}): Promise<MaintenanceRun> {
  const now = options.now ?? new Date();
  const projectId = options.projectId ?? null;
  const windowKey = dailyWindowKey(now);
  const startedAt = Date.now();

  const runId = await claimWindow("daily", windowKey, projectId);
  if (!runId) return existingRun("daily", windowKey, projectId);

  let checksRun = 0;
  let checksFailed = 0;
  let opened = 0;
  let resolved = 0;
  let considered = 0;
  const staleSlugs = new Set<string>();
  const detail: Record<string, unknown> = {};
  const failedChecks: string[] = [];

  for (const detector of DAILY_DETECTORS) {
    try {
      const result = await detector(projectId);
      checksRun += 1;
      considered += result.considered;
      const applied = await applyFindings(result, runId, projectId);
      opened += applied.opened;
      resolved += applied.resolved;
      for (const slug of applied.slugs) staleSlugs.add(slug);
      detail[result.kind] = {
        findings: result.findings.length,
        considered: result.considered,
        opened: applied.opened,
        resolved: applied.resolved,
      };
    } catch (err) {
      // One broken check must not cost the operator every other finding.
      checksFailed += 1;
      const name = detector.name;
      failedChecks.push(name);
      detail[name] = { error: err instanceof Error ? err.message : "unknown" };
      log("error", "knowledge.maintenance.check_failed", { check: name, runId });
    }
  }

  // Rebuild only what a detector flagged. Never a blanket recompile.
  let rebuilt = 0;
  if (options.rebuild !== false && staleSlugs.size > 0) {
    try {
      const build = await compileAffected({
        projectId,
        slugs: [...staleSlugs],
        trigger: "maintenance",
        triggerRef: runId,
      });
      rebuilt = build.compiled;
      detail.rebuild = { requested: staleSlugs.size, compiled: build.compiled, failed: build.failed };
    } catch (err) {
      checksFailed += 1;
      failedChecks.push("rebuild");
      detail.rebuild = { error: err instanceof Error ? err.message : "unknown" };
    }
  }

  if (failedChecks.length > 0) detail.failedChecks = failedChecks;
  const status = checksFailed > 0 ? "partial" : "completed";
  await finish(runId, status, {
    checksRun,
    checksFailed,
    opened,
    resolved,
    rebuilt,
    considered,
    detail,
    startedAt,
  });

  return {
    id: runId,
    kind: "daily",
    windowKey,
    status,
    checksRun,
    checksFailed,
    exceptionsOpened: opened,
    exceptionsResolved: resolved,
    pagesRebuilt: rebuilt,
    pagesConsidered: considered,
    durationMs: Date.now() - startedAt,
    alreadyRan: false,
    detail,
  };
}

/** Weekly deeper review. Adds the contradiction scan and usefulness signals. */
export async function runWeeklyMaintenance(options: RunOptions = {}): Promise<MaintenanceRun> {
  const now = options.now ?? new Date();
  const projectId = options.projectId ?? null;
  const windowKey = weeklyWindowKey(now);
  const startedAt = Date.now();

  const runId = await claimWindow("weekly", windowKey, projectId);
  if (!runId) return existingRun("weekly", windowKey, projectId);

  let checksRun = 0;
  let checksFailed = 0;
  let opened = 0;
  let resolved = 0;
  let considered = 0;
  const detail: Record<string, unknown> = {};
  const failedChecks: string[] = [];

  for (const detector of WEEKLY_DETECTORS) {
    try {
      const result = await detector(projectId);
      checksRun += 1;
      considered += result.considered;
      const applied = await applyFindings(result, runId, projectId);
      opened += applied.opened;
      resolved += applied.resolved;
      detail[result.kind] = {
        findings: result.findings.length,
        considered: result.considered,
        opened: applied.opened,
      };
    } catch (err) {
      checksFailed += 1;
      failedChecks.push(detector.name);
      detail[detector.name] = { error: err instanceof Error ? err.message : "unknown" };
      log("error", "knowledge.maintenance.check_failed", { check: detector.name, runId });
    }
  }

  // The contradiction scan is its own service (spec 020) and writes into
  // claim_contradictions, so it reports rather than raising exceptions here.
  if (projectId) {
    try {
      const scan = await scanProjectContradictions(projectId);
      checksRun += 1;
      detail.contradiction_scan = scan;
    } catch (err) {
      checksFailed += 1;
      failedChecks.push("contradiction_scan");
      detail.contradiction_scan = { error: err instanceof Error ? err.message : "unknown" };
    }
  }

  try {
    detail.usefulness = await measureUsefulness(projectId);
    checksRun += 1;
  } catch {
    checksFailed += 1;
    failedChecks.push("usefulness");
  }

  if (failedChecks.length > 0) detail.failedChecks = failedChecks;
  const status = checksFailed > 0 ? "partial" : "completed";
  await finish(runId, status, {
    checksRun,
    checksFailed,
    opened,
    resolved,
    // The weekly review never rebuilds: its findings are judgements a human
    // must make, not faults a recompile fixes.
    rebuilt: 0,
    considered,
    detail,
    startedAt,
  });

  return {
    id: runId,
    kind: "weekly",
    windowKey,
    status,
    checksRun,
    checksFailed,
    exceptionsOpened: opened,
    exceptionsResolved: resolved,
    pagesRebuilt: 0,
    pagesConsidered: considered,
    durationMs: Date.now() - startedAt,
    alreadyRan: false,
    detail,
  };
}

export async function recentMaintenanceRuns(limit = 20): Promise<MaintenanceRun[]> {
  const rows = await sql`
    select * from knowledge_maintenance_runs order by started_at desc limit ${limit}
  `;
  return rows.map((row) => ({
    id: row.id as string,
    kind: row.kind as "daily" | "weekly",
    windowKey: row.windowKey as string,
    status: row.status as MaintenanceRun["status"],
    checksRun: Number(row.checksRun ?? 0),
    checksFailed: Number(row.checksFailed ?? 0),
    exceptionsOpened: Number(row.exceptionsOpened ?? 0),
    exceptionsResolved: Number(row.exceptionsResolved ?? 0),
    pagesRebuilt: Number(row.pagesRebuilt ?? 0),
    pagesConsidered: Number(row.pagesConsidered ?? 0),
    durationMs: Number(row.durationMs ?? 0),
    alreadyRan: false,
    detail: (row.detail as Record<string, unknown>) ?? {},
  }));
}
