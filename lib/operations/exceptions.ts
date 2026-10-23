/**
 * The exception queue (spec 151 C3): one read model over every place routine
 * operation can stall, so the operator manages exceptions instead of
 * walking every project. Read-only; each item links to where it is fixed.
 * Thresholds are named here, once.
 */
import { sql } from "@/db/client";
import { assertCanWrite, type CurrentUser } from "@/lib/auth";
import { DAILY_SPEND_CEILING_USD } from "@/lib/constants";

export const EXCEPTION_WINDOWS = {
  failedRunsDays: 14,
  failedJobsDays: 7,
  /** A scheduled retest still queued this long after its due time is late. */
  retestGraceHours: 24,
  /** Pending reviews older than this block scoring and are exceptions. */
  reviewStaleHours: 48,
  /** A live engagement without a published report this long is late. */
  reportStaleDays: 35,
  /** Approved work with no movement this long is stalled. */
  stalledOpportunityDays: 30,
  /** Approved plan never linked to what shipped. */
  unlinkedPlanDays: 30,
  /** Nightly backups: no successful run for this long is an incident. */
  backupStaleHours: 26,
} as const;

export type ExceptionKind =
  | "failed_run"
  | "failed_job"
  | "overdue_retest"
  | "overdue_approval"
  | "pending_review"
  | "over_budget_run"
  | "daily_spend"
  | "stale_report"
  | "connector_failure"
  | "stalled_opportunity"
  | "unlinked_plan"
  | "internal_inference_unreachable"
  | "backup_stale";

export interface ExceptionItem {
  kind: ExceptionKind;
  severity: "high" | "medium" | "low";
  projectId: string | null;
  projectName: string | null;
  summary: string;
  since: Date | null;
  href: string | null;
}

export async function exceptionQueue(user: CurrentUser): Promise<ExceptionItem[]> {
  assertCanWrite(user); // staff only — crosses clients
  const W = EXCEPTION_WINDOWS;
  const items: ExceptionItem[] = [];

  const failedRuns = await sql`
    select r.id, r.project_id, p.name, r.label, r.status_detail, r.started_at from runs r join projects p on p.id = r.project_id
    where r.status = 'failed' and r.started_at > now() - make_interval(days => ${W.failedRunsDays})
    order by r.started_at desc limit 50
  `;
  for (const r of failedRuns) {
    items.push({
      kind: "failed_run",
      severity: "high",
      projectId: r.projectId as string,
      projectName: r.name as string,
      summary: `Run "${r.label as string}" failed${r.statusDetail ? `: ${r.statusDetail as string}` : ""}.`,
      since: r.startedAt as Date,
      href: `/projects/${r.projectId as string}/runs/${r.id as string}`,
    });
  }

  const failedJobs = await sql`
    select type, count(*)::int as n, max(created_at) as last from jobs
    where status = 'failed' and created_at > now() - make_interval(days => ${W.failedJobsDays})
    group by type order by n desc
  `;
  for (const j of failedJobs) {
    items.push({
      kind: "failed_job",
      severity: (j.n as number) >= 5 ? "high" : "medium",
      projectId: null,
      projectName: null,
      summary: `${j.n as number} "${j.type as string}" job(s) failed after retries.`,
      since: j.last as Date,
      href: "/control-tower",
    });
  }

  const retests = await sql`
    select j.id, j.run_after, j.payload, p.id as project_id, p.name from jobs j
    left join interventions i on i.id = (j.payload->>'interventionId')::uuid
    left join projects p on p.id = i.project_id
    where j.type = 'start_scheduled_run' and j.status = 'queued'
      and j.run_after < now() - make_interval(hours => ${W.retestGraceHours})
    order by j.run_after limit 50
  `;
  for (const r of retests) {
    items.push({
      kind: "overdue_retest",
      severity: "high",
      projectId: (r.projectId as string | null) ?? null,
      projectName: (r.name as string | null) ?? null,
      summary: "A scheduled retest is overdue — is the worker running?",
      since: r.runAfter as Date,
      href: r.projectId ? `/projects/${r.projectId as string}/interventions` : "/control-tower",
    });
  }

  const approvals = await sql`
    select a.id, a.project_id, p.name, a.summary, a.due_at, a.requested_at from workflow_approvals a
    left join projects p on p.id = a.project_id
    where a.decision is null and a.due_at is not null and a.due_at < now()
    order by a.due_at limit 50
  `;
  for (const a of approvals) {
    items.push({
      kind: "overdue_approval",
      severity: "medium",
      projectId: (a.projectId as string | null) ?? null,
      projectName: (a.name as string | null) ?? null,
      summary: `Approval past due: ${a.summary as string}`,
      since: a.dueAt as Date,
      href: "/approvals",
    });
  }

  const reviews = await sql`
    select run.project_id, p.name, count(*)::int as n, min(m.created_at) as oldest
    from mentions m join responses r on r.id = m.response_id join runs run on run.id = r.run_id
    join projects p on p.id = run.project_id
    where m.needs_review and m.reviewed_by is null
      and m.created_at < now() - make_interval(hours => ${W.reviewStaleHours})
      and not exists (select 1 from mentions newer where newer.response_id = m.response_id
        and newer.company_id = m.company_id and newer.revision > m.revision)
    group by run.project_id, p.name
  `;
  for (const r of reviews) {
    items.push({
      kind: "pending_review",
      severity: "medium",
      projectId: r.projectId as string,
      projectName: r.name as string,
      summary: `${r.n as number} classification(s) awaiting review — scoring is blocked until cleared.`,
      since: r.oldest as Date,
      href: `/projects/${r.projectId as string}/review`,
    });
  }

  const overBudget = await sql`
    select r.id, r.project_id, p.name, r.label, r.cost_usd::float8 as cost, r.budget_usd::float8 as budget, r.started_at
    from runs r join projects p on p.id = r.project_id
    where r.cost_usd > r.budget_usd and r.started_at > now() - make_interval(days => ${W.failedRunsDays})
  `;
  for (const r of overBudget) {
    items.push({
      kind: "over_budget_run",
      severity: "medium",
      projectId: r.projectId as string,
      projectName: r.name as string,
      summary: `Run "${r.label as string}" cost $${Number(r.cost).toFixed(2)} against a $${Number(r.budget).toFixed(2)} budget.`,
      since: r.startedAt as Date,
      href: `/projects/${r.projectId as string}/runs/${r.id as string}`,
    });
  }

  const [spend] = await sql`
    select (coalesce((select sum(cost_usd) from responses where requested_at > now() - interval '24 hours'), 0)
      + coalesce((select sum(cost_micro_usd) from llm_calls where called_at > now() - interval '24 hours'), 0) / 1e6)::float8 as usd
  `;
  const spent = Number(spend?.usd ?? 0);
  if (spent >= DAILY_SPEND_CEILING_USD * 0.9) {
    items.push({
      kind: "daily_spend",
      severity: spent >= DAILY_SPEND_CEILING_USD ? "high" : "medium",
      projectId: null,
      projectName: null,
      summary: `$${spent.toFixed(2)} spent in 24h against a $${DAILY_SPEND_CEILING_USD} ceiling.`,
      since: null,
      href: "/control-tower",
    });
  }

  const reports = await sql`
    select e.project_id, p.name, (select max(published_at) from reports r where r.project_id = e.project_id and r.status = 'published') as last
    from client_engagements e join projects p on p.id = e.project_id
    where e.stage in ('active', 'renewal_review')
  `;
  for (const r of reports) {
    const last = (r.last as Date | null) ?? null;
    if (last && Date.now() - last.getTime() < W.reportStaleDays * 86400000) continue;
    items.push({
      kind: "stale_report",
      severity: "medium",
      projectId: r.projectId as string,
      projectName: r.name as string,
      summary: last ? `No report published since ${last.toLocaleDateString()}.` : "Active client has never received a published report.",
      since: last,
      href: `/projects/${r.projectId as string}/reports`,
    });
  }

  const connectors = await sql`
    select distinct on (h.connection_id) h.connection_id, h.project_id, p.name, h.error_code, h.severity, h.checked_at
    from connector_health_checks h left join projects p on p.id = h.project_id
    order by h.connection_id, h.checked_at desc
  `;
  for (const c of connectors.filter((x) => x.errorCode)) {
    items.push({
      kind: "connector_failure",
      severity: c.severity === "critical" || c.severity === "high" ? "high" : "low",
      projectId: (c.projectId as string | null) ?? null,
      projectName: (c.name as string | null) ?? null,
      summary: `Connector health check failing (${c.errorCode as string}).`,
      since: c.checkedAt as Date,
      href: "/automation",
    });
  }

  const stalled = await sql`
    select o.id, o.project_id, p.name, o.title, o.status, o.updated_at from opportunities o join projects p on p.id = o.project_id
    where o.status in ('approved', 'in_progress', 'implemented')
      and o.updated_at < now() - make_interval(days => ${W.stalledOpportunityDays})
  `;
  for (const o of stalled) {
    items.push({
      kind: "stalled_opportunity",
      severity: "low",
      projectId: o.projectId as string,
      projectName: o.name as string,
      summary: `"${o.title as string}" has been ${o.status as string} for over ${W.stalledOpportunityDays} days.`,
      since: o.updatedAt as Date,
      href: `/projects/${o.projectId as string}/optimization`,
    });
  }

  const plans = await sql`
    select ip.id, ip.project_id, p.name, ip.hypothesis, ip.approved_at from intervention_plans ip join projects p on p.id = ip.project_id
    where ip.status = 'approved' and ip.intervention_id is null
      and ip.approved_at < now() - make_interval(days => ${W.unlinkedPlanDays})
  `;
  for (const pl of plans) {
    items.push({
      kind: "unlinked_plan",
      severity: "low",
      projectId: pl.projectId as string,
      projectName: pl.name as string,
      summary: `An approved experiment plan has no recorded intervention: "${String(pl.hypothesis).slice(0, 80)}".`,
      since: pl.approvedAt as Date,
      href: `/projects/${pl.projectId as string}/optimization`,
    });
  }

  // Promoted internal tasks fail closed without their inference host.
  const { INTERNAL_TASK_TARGETS } = await import("@/lib/ai/routing");
  const targets = Object.entries(INTERNAL_TASK_TARGETS).filter(([, t]) => t?.backend === "ollama");
  if (targets.length > 0) {
    const { ollamaHealth } = await import("@/lib/ai/internal/ollama");
    const health = await ollamaHealth([...new Set(targets.map(([, t]) => t!.model))]);
    if (!health.reachable || health.missingModels.length > 0) {
      items.push({
        kind: "internal_inference_unreachable",
        severity: "high",
        projectId: null,
        projectName: null,
        summary: health.reachable
          ? `Internal inference host is missing model(s) ${health.missingModels.join(", ")}; ${targets.map(([k]) => k).join(", ")} will fail closed.`
          : `Internal inference host unreachable (${health.error ?? "no response"}); ${targets.map(([k]) => k).join(", ")} fail closed until it is back.`,
        since: null,
        href: null,
      });
    }
  }

  // Backups (release 151): scripts/backup.sh records every attempt.
  const [backup] = await sql`
    select max(finished_at) filter (where ok) as last_ok,
      bool_or(not ok) filter (where finished_at > now() - make_interval(hours => ${W.backupStaleHours})) as recent_failure,
      count(*)::int as attempts
    from backup_runs
  `;
  const lastOk = (backup?.lastOk as Date | null) ?? null;
  const stale = lastOk === null || Date.now() - lastOk.getTime() > W.backupStaleHours * 3600_000;
  if ((backup?.attempts as number) > 0 || process.env.NODE_ENV === "production") {
    if (stale || backup?.recentFailure) {
      items.push({
        kind: "backup_stale",
        severity: "high",
        projectId: null,
        projectName: null,
        summary: lastOk
          ? `Last successful backup ${lastOk.toLocaleString()}${backup?.recentFailure ? "; a backup failed since" : ""}.`
          : "No successful backup has been recorded.",
        since: lastOk,
        href: null,
      });
    }
  }

  const rank = { high: 0, medium: 1, low: 2 } as const;
  return items.sort((a, b) => rank[a.severity] - rank[b.severity] || (a.since?.getTime() ?? 0) - (b.since?.getTime() ?? 0));
}
