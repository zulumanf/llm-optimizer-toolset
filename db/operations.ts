/**
 * Agency operations feed (docs/17 A3). Answers the one question an operator
 * running many clients asks every morning: **what needs me today?**
 *
 * One pass over the per-client signals, mapped to attention items whose
 * severity is assigned in code (never ad hoc), so the queue orders the same
 * way for every operator and can be explained to a client.
 */
import { sql } from "@/db/client";
import { REVIEW_TIMEOUT_HOURS } from "@/lib/constants";

export type AttentionKind =
  | "review_queue"
  | "run_failed"
  | "job_failed"
  | "accuracy_high"
  | "scheduled_run_due"
  | "approvals_waiting"
  | "content_waiting"
  | "no_subject"
  | "no_baseline"
  | "never_run"
  | "stale_client"
  | "gaps_open"
  | "cycle_halted"
  // Derived in lib/competitors/movement.ts (spec 030) and merged into the
  // feed by lib/notifications/feed.ts — not produced by signals() below.
  | "competitor_overtake"
  | "visibility_drop"
  // C6: automation failures must reach the inbox an operator actually
  // watches — workflow_exceptions previously surfaced only on /control-tower.
  | "workflow_exception";

export type Severity = "urgent" | "attention" | "info";

/** Deterministic severity per signal (docs/17): "urgent" means the client's
 * measurement is broken or a factual problem is live; "attention" means work
 * is queued on a human; "info" is configuration hygiene. */
const SEVERITY: Record<AttentionKind, Severity> = {
  run_failed: "urgent",
  job_failed: "urgent",
  accuracy_high: "urgent",
  review_queue: "attention",
  scheduled_run_due: "attention",
  approvals_waiting: "attention",
  content_waiting: "attention",
  no_subject: "urgent",
  no_baseline: "info",
  never_run: "info",
  stale_client: "info",
  gaps_open: "info",
  // Automation stopped and is waiting on a human decision (spec 017)
  cycle_halted: "urgent",
  // Movement is client-facing news, not broken measurement (spec 030)
  competitor_overtake: "attention",
  visibility_drop: "attention",
  // Broken or safe-stopped automation is measurement-affecting news
  workflow_exception: "urgent",
};

const SEVERITY_ORDER: Record<Severity, number> = {
  urgent: 0,
  attention: 1,
  info: 2,
};

/** A client with a configured baseline that has not run in this many days is
 * drifting — the trend line develops holes. */
export const STALE_CLIENT_DAYS = 14;

export interface AttentionItem {
  projectId: string;
  projectName: string;
  kind: AttentionKind;
  severity: Severity;
  count: number;
  detail: string;
  href: string;
}

export interface AgencyMetrics {
  activeClients: number;
  clientsNeedingAttention: number;
  spend7d: number;
  spend30d: number;
  runs7d: number;
  pendingReviews: number;
  failedJobs: number;
}

interface SignalRow {
  id: string;
  name: string;
  hasSubject: boolean;
  hasBaseline: boolean;
  runCount: number;
  daysSinceRun: number | null;
  failedRuns: number;
  pendingReviews: number;
  staleReviews: number;
  highAccuracy: number;
  openGaps: number;
  suggestedTasks: number;
  contentWaiting: number;
  dueScheduledRuns: number;
  openWorkflowExceptions: number;
  severeWorkflowExceptions: number;
  spend7d: number;
  spend30d: number;
  runs7d: number;
  cycleHaltReason: string | null;
}

async function signals(): Promise<SignalRow[]> {
  return sql<SignalRow[]>`
    select
      p.id, p.name,
      (coalesce(p.subject_company_id, (select c.id from companies c
        where c.is_self and c.archived_at is null limit 1)) is not null) as has_subject,
      (p.baseline_prompt_set_id is not null) as has_baseline,
      (select count(*)::int from runs r where r.project_id = p.id) as run_count,
      (select extract(day from now() - max(r.started_at))::int
         from runs r where r.project_id = p.id) as days_since_run,
      (select count(*)::int from runs r
        where r.project_id = p.id and r.status in ('failed', 'partial')
          and r.started_at > now() - interval '14 days') as failed_runs,
      (select count(*)::int from mentions m
        join responses resp on resp.id = m.response_id
        join runs r on r.id = resp.run_id
        where r.project_id = p.id and m.needs_review
          and not exists (select 1 from mentions n
            where n.response_id = m.response_id and n.company_id = m.company_id
              and n.revision > m.revision)) as pending_reviews,
      (select count(*)::int from mentions m
        join responses resp on resp.id = m.response_id
        join runs r on r.id = resp.run_id
        where r.project_id = p.id and m.needs_review
          and m.created_at < now() - make_interval(hours => ${REVIEW_TIMEOUT_HOURS})
          and not exists (select 1 from mentions n
            where n.response_id = m.response_id and n.company_id = m.company_id
              and n.revision > m.revision)) as stale_reviews,
      (select count(*)::int from accuracy_findings a
        where a.project_id = p.id and a.status = 'open' and a.severity = 'high')
        as high_accuracy,
      (select count(*)::int from gap_findings g
        where g.project_id = p.id and g.status = 'open') as open_gaps,
      (select c.halt_reason from cycle_runs c
        where c.project_id = p.id and c.state = 'halted'
        order by c.week_start desc limit 1) as cycle_halt_reason,
      (select count(*)::int from tasks t
        where t.project_id = p.id and t.status = 'suggested') as suggested_tasks,
      (select count(*)::int from content_assets ca
        where ca.project_id = p.id and ca.status in ('drafted', 'verified'))
        as content_waiting,
      (select count(*)::int from workflow_exceptions we
        where we.project_id = p.id and we.status in ('open', 'acknowledged'))
        as open_workflow_exceptions,
      (select count(*)::int from workflow_exceptions we
        where we.project_id = p.id and we.status in ('open', 'acknowledged')
          and we.severity in ('high', 'critical'))
        as severe_workflow_exceptions,
      (select count(*)::int from jobs j
        where j.type = 'start_scheduled_run' and j.status = 'queued'
          and j.run_after < now()
          and j.payload->>'projectId' = p.id::text) as due_scheduled_runs,
      -- Run spend + project-attributed agent spend (llm_calls, spec 050).
      -- Unattributed agent calls count only in the global ceiling.
      coalesce((select sum(r.cost_usd) from runs r
        where r.project_id = p.id and r.started_at > now() - interval '7 days'), 0)
      + coalesce((select sum(lc.cost_micro_usd) / 1e6 from llm_calls lc
        where lc.project_id = p.id and lc.called_at > now() - interval '7 days'), 0)
        as spend7d,
      coalesce((select sum(r.cost_usd) from runs r
        where r.project_id = p.id and r.started_at > now() - interval '30 days'), 0)
      + coalesce((select sum(lc.cost_micro_usd) / 1e6 from llm_calls lc
        where lc.project_id = p.id and lc.called_at > now() - interval '30 days'), 0)
        as spend30d,
      (select count(*)::int from runs r
        where r.project_id = p.id and r.started_at > now() - interval '7 days')
        as runs7d
    from projects p
    where p.status = 'active' and p.kind = 'client'
    order by p.name asc
  `;
}

function item(
  row: SignalRow,
  kind: AttentionKind,
  count: number,
  detail: string,
  path: string
): AttentionItem {
  return {
    projectId: row.id,
    projectName: row.name,
    kind,
    severity: SEVERITY[kind],
    count,
    detail,
    href: `/projects/${row.id}${path}`,
  };
}

export async function attentionFeed(): Promise<{
  items: AttentionItem[];
  metrics: AgencyMetrics;
}> {
  const rows = await signals();
  const items: AttentionItem[] = [];

  for (const row of rows) {
    if (row.cycleHaltReason) {
      items.push(
        item(row, "cycle_halted", 1,
          `This week's automated cycle stopped: ${row.cycleHaltReason}`, "/runs")
      );
    }
    if (!row.hasSubject) {
      items.push(
        item(row, "no_subject", 1, "No subject company — parsing and scoring are blocked.", "/knowledge")
      );
    }
    if (row.failedRuns > 0) {
      items.push(
        item(row, "run_failed", row.failedRuns,
          `${row.failedRuns} run(s) failed or completed partially in the last 14 days.`, "/runs")
      );
    }
    if (row.openWorkflowExceptions > 0) {
      const severe =
        row.severeWorkflowExceptions > 0
          ? ` ${row.severeWorkflowExceptions} high/critical.`
          : "";
      items.push({
        projectId: row.id,
        projectName: row.name,
        kind: "workflow_exception",
        severity: SEVERITY.workflow_exception,
        count: row.openWorkflowExceptions,
        detail: `${row.openWorkflowExceptions} open workflow exception(s) — automation stopped or failed and is waiting on you.${severe}`,
        // Cross-client surface: exceptions are resolved from the control
        // tower's queue, not a project page.
        href: "/control-tower",
      });
    }
    if (row.highAccuracy > 0) {
      items.push(
        item(row, "accuracy_high", row.highAccuracy,
          `${row.highAccuracy} open high-severity factual problem(s) in AI answers.`, "/accuracy")
      );
    }
    if (row.pendingReviews > 0) {
      const stale = row.staleReviews > 0 ? ` ${row.staleReviews} past the review window.` : "";
      items.push(
        item(row, "review_queue", row.pendingReviews,
          `${row.pendingReviews} classification(s) awaiting review — scoring is blocked until cleared.${stale}`,
          "/review")
      );
    }
    if (row.dueScheduledRuns > 0) {
      items.push(
        item(row, "scheduled_run_due", row.dueScheduledRuns,
          `${row.dueScheduledRuns} scheduled measurement run(s) are due — is the worker running?`,
          "/interventions")
      );
    }
    if (row.suggestedTasks > 0) {
      items.push(
        item(row, "approvals_waiting", row.suggestedTasks,
          `${row.suggestedTasks} suggested task(s) awaiting your approval.`, "/tasks")
      );
    }
    if (row.contentWaiting > 0) {
      items.push(
        item(row, "content_waiting", row.contentWaiting,
          `${row.contentWaiting} content draft(s) awaiting verification or approval.`, "/content")
      );
    }
    if (row.runCount === 0) {
      items.push(
        item(row, "never_run", 1, "No benchmark has run yet — freeze a prompt set and start a baseline.", "/prompts")
      );
    } else if (row.hasBaseline && (row.daysSinceRun ?? 0) >= STALE_CLIENT_DAYS) {
      items.push(
        item(row, "stale_client", row.daysSinceRun ?? 0,
          `No run in ${row.daysSinceRun} days — the trend line is developing a hole.`, "/runs")
      );
    }
    if (!row.hasBaseline && row.runCount > 0) {
      items.push(
        item(row, "no_baseline", 1,
          "No weekly baseline configured — measurement depends on manual runs.", "/settings")
      );
    }
    if (row.openGaps > 0) {
      items.push(
        item(row, "gaps_open", row.openGaps,
          `${row.openGaps} open evidence gap(s) with no action taken yet.`, "/gaps")
      );
    }
  }

  items.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      b.count - a.count ||
      a.projectName.localeCompare(b.projectName)
  );

  const [jobHealth] = await sql`
    select count(*) filter (where status = 'failed')::int as failed from jobs
  `;
  const needingAttention = new Set(
    items.filter((i) => i.severity !== "info").map((i) => i.projectId)
  );

  return {
    items,
    metrics: {
      activeClients: rows.length,
      clientsNeedingAttention: needingAttention.size,
      spend7d: rows.reduce((sum, r) => sum + Number(r.spend7d), 0),
      spend30d: rows.reduce((sum, r) => sum + Number(r.spend30d), 0),
      runs7d: rows.reduce((sum, r) => sum + r.runs7d, 0),
      pendingReviews: rows.reduce((sum, r) => sum + r.pendingReviews, 0),
      failedJobs: (jobHealth?.failed as number) ?? 0,
    },
  };
}

/** Per-client cost + activity rollup (docs/17 B3) — margin visibility. */
export async function clientCostRollup(): Promise<
  { projectId: string; projectName: string; spend7d: number; spend30d: number; runs7d: number }[]
> {
  const rows = await signals();
  return rows
    .map((r) => ({
      projectId: r.id,
      projectName: r.name,
      spend7d: Number(r.spend7d),
      spend30d: Number(r.spend30d),
      runs7d: r.runs7d,
    }))
    .sort((a, b) => b.spend30d - a.spend30d);
}
