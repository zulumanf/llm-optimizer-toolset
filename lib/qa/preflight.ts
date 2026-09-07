/**
 * QA preflight (spec 065, qa-preflight-v1): the one pre-publication check
 * vocabulary for client-facing artifacts. The whole-OS audit found each
 * publish path reinventing its own subset while nothing checked methodology
 * versions, failed runs, freshness, or source-link liveness. Check builders
 * are pure (known-answer tests); the gatherers touch the database or the
 * network through the platform's single egress policy.
 *
 * Levels: a `block` can never be acknowledged away; a `warn` always can,
 * with the acknowledgment recorded by the caller.
 */
import { staleness, FRESHNESS_WINDOWS_DAYS } from "@/lib/prospects/constants";
import { safeFetch, type SafeFetchDeps } from "@/lib/security/safe-fetch";
import type { ReportBody } from "@/lib/reports/types";

export const QA_PREFLIGHT_VERSION = "qa-preflight-v1";

export interface PreflightCheck {
  id: string;
  level: "block" | "warn";
  ok: boolean;
  detail: string;
}

export interface PreflightResult {
  version: string;
  checks: PreflightCheck[];
  blockers: PreflightCheck[];
  warnings: PreflightCheck[];
}

export function settlePreflight(checks: PreflightCheck[]): PreflightResult {
  return {
    version: QA_PREFLIGHT_VERSION,
    checks,
    blockers: checks.filter((c) => !c.ok && c.level === "block"),
    warnings: checks.filter((c) => !c.ok && c.level === "warn"),
  };
}

// ------------------------------------------------------ pure check builders

/** A report without its scoring version can never be compared honestly
 * later — cross-version comparison is the forbidden read (docs/06). */
export function checkMethodologyVersion(scoringVersion: unknown): PreflightCheck {
  const present = typeof scoringVersion === "string" && scoringVersion.length > 0;
  return {
    id: "methodology_version",
    level: "block",
    ok: present,
    detail: present
      ? `scoring version ${scoringVersion as string} recorded`
      : "the report body carries no scoring version — it cannot be compared against anything later",
  };
}

export function checkIncludedRunsHealthy(
  runs: { label: string; status: string; statusDetail: string | null }[]
): PreflightCheck {
  const unhealthy = runs.filter((r) => r.status === "partial" || r.status === "failed");
  return {
    id: "included_runs_healthy",
    level: "warn",
    ok: unhealthy.length === 0,
    detail:
      unhealthy.length === 0
        ? `all ${runs.length} included run(s) completed`
        : unhealthy
            .map((r) => `"${r.label}" ${r.status}${r.statusDetail ? ` (${r.statusDetail})` : ""}`)
            .join(" · "),
  };
}

export function checkNoUnexaminedFailedRuns(
  failed: { label: string }[]
): PreflightCheck {
  return {
    id: "no_unexamined_failed_runs",
    level: "warn",
    ok: failed.length === 0,
    detail:
      failed.length === 0
        ? "no failed runs in the reporting window outside the report"
        : `${failed.length} failed run(s) in the window are not in this report: ${failed
            .map((r) => `"${r.label}"`)
            .join(", ")} — a silent hole in the period`,
  };
}

export function checkMeasurementFresh(
  currentRunStartedAt: string | null,
  now: Date = new Date()
): PreflightCheck {
  if (!currentRunStartedAt) {
    return {
      id: "measurement_fresh",
      level: "warn",
      ok: false,
      detail: "the report's current run has no recorded start date",
    };
  }
  const age = staleness(currentRunStartedAt, FRESHNESS_WINDOWS_DAYS.benchmark, now);
  return {
    id: "measurement_fresh",
    level: "warn",
    ok: !age.stale,
    detail: age.stale
      ? `the current run is ${age.ageDays} days old — past the ${FRESHNESS_WINDOWS_DAYS.benchmark}-day freshness window`
      : `current run is ${age.ageDays} days old (window ${FRESHNESS_WINDOWS_DAYS.benchmark}d)`,
  };
}

/** Defense in depth behind the scoring guard: a mock-fed artifact must be
 * unpublishable at every layer, not only at score time. */
export function checkNoMockResponses(
  providers: string[],
  mockAllowed: boolean
): PreflightCheck {
  const hasMock = providers.includes("mock");
  return {
    id: "no_mock_responses",
    level: "block",
    ok: !hasMock || mockAllowed,
    detail:
      hasMock && !mockAllowed
        ? "the benchmark contains mock-provider responses and mock scoring is not allowed in this environment"
        : hasMock
          ? "mock responses present — permitted in this environment"
          : "no mock responses",
  };
}

// -------------------------------------------------------------- gatherers

/**
 * Preflight for a report draft. Composes what the body already carries with
 * two queries: the included runs' statuses, and failed project runs inside
 * the reporting window that the report does not include.
 */
export async function reportPreflight(
  projectId: string,
  body: ReportBody,
  now: Date = new Date()
): Promise<PreflightResult> {
  const { sql } = await import("@/db/client");
  const runIds = body.runs.map((r) => r.id);
  const statusRows =
    runIds.length > 0
      ? await sql`
          select id, label, status, status_detail from runs
          where id = any(${runIds}::uuid[])
        `
      : [];

  const previous = body.previousRunId
    ? body.runs.find((r) => r.id === body.previousRunId)
    : null;
  const failedRows = await sql`
    select label from runs
    where project_id = ${projectId} and status = 'failed'
      and id != all(${runIds}::uuid[])
      ${previous ? sql`and started_at >= ${previous.startedAt}` : sql``}
      and started_at <= ${body.generatedAt}
    order by started_at desc
    limit 10
  `;

  const current = body.runs.find((r) => r.id === body.currentRunId) ?? null;

  return settlePreflight([
    checkMethodologyVersion(body.scoringVersion),
    checkIncludedRunsHealthy(
      statusRows.map((r) => ({
        label: r.label as string,
        status: r.status as string,
        statusDetail: (r.statusDetail as string | null) ?? null,
      }))
    ),
    checkNoUnexaminedFailedRuns(
      failedRows.map((r) => ({ label: r.label as string }))
    ),
    checkMeasurementFresh(current?.startedAt ?? null, now),
  ]);
}

// -------------------------------------------------- source-link liveness

export const SOURCE_LINK_TIMEOUT_MS = 6_000;
export const SOURCE_LINK_MAX_BYTES = 512 * 1024;
/** Cap the publish-time fetches: the receipts a prospect can click are few
 * by construction, and publish must stay an interactive action. */
export const SOURCE_LINK_MAX_CHECKS = 6;

export interface DeadLink {
  url: string;
  note: string;
}

/** Test seam: publishAudit cannot thread fetch deps through its zod input,
 * so integration tests inject a stub here. Never set in production code. */
let injectedFetchDeps: SafeFetchDeps | null = null;
export function setSourceLinkFetchDeps(deps: SafeFetchDeps | null): void {
  injectedFetchDeps = deps;
}

/**
 * Fetch each prospect-visible source URL through safeFetch and report the
 * dead ones. Skipped entirely (empty result, by design) when
 * QA_SOURCE_LINK_CHECKS=off and no fetch impl is injected — the test
 * environment must never touch the network (docs/09), while tests that
 * exercise this check inject a stub.
 */
export async function deadSourceLinks(
  urls: string[],
  deps: SafeFetchDeps = {}
): Promise<DeadLink[]> {
  if (!deps.fetchImpl && injectedFetchDeps) deps = injectedFetchDeps;
  if (!deps.fetchImpl && process.env.QA_SOURCE_LINK_CHECKS === "off") {
    return [];
  }
  const unique = [...new Set(urls.filter(Boolean))].slice(0, SOURCE_LINK_MAX_CHECKS);
  const dead: DeadLink[] = [];
  for (const url of unique) {
    try {
      const response = await safeFetch(
        url,
        { timeoutMs: SOURCE_LINK_TIMEOUT_MS, maxBytes: SOURCE_LINK_MAX_BYTES },
        deps
      );
      if (!response.ok) {
        dead.push({ url, note: `HTTP ${response.status} ${response.statusText}` });
      }
    } catch (err) {
      dead.push({
        url,
        note: err instanceof Error ? err.message.slice(0, 200) : "fetch failed",
      });
    }
  }
  return dead;
}
