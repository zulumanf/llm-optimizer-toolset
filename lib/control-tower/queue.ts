/**
 * The unified action-required queue (spec 019 Part B).
 *
 * Five subsystems already know something needs a human: workflow exceptions,
 * pending approvals, gap findings, accuracy findings, and the derived
 * attention feed. None of them can be ordered against each other, because
 * "urgent" is a category, not a rank.
 *
 * This module merges them and applies one deterministic formula
 * (lib/workflow/exceptions.ts) so a queue of forty items across nine clients
 * has an answer to "what first?" that can be explained to the client whose
 * item came second.
 */
import { sql } from "@/db/client";
import {
  computePriority,
  type PriorityBreakdown,
  type ExceptionKind,
} from "@/lib/workflow/exceptions";
import type { RiskLevel } from "@/lib/workflow/types";

export type QueueSource =
  | "workflow_exception"
  | "workflow_approval"
  | "drift_signal"
  | "gap_finding"
  | "accuracy_finding"
  | "content_approval"
  | "task_overdue"
  | "intervention_blocked";

export interface QueueItem {
  id: string;
  source: QueueSource;
  kind: string;
  projectId: string | null;
  projectName: string;
  summary: string;
  recommendedAction: string;
  severity: RiskLevel;
  dueAt: Date | null;
  createdAt: Date;
  href: string;
  priority: PriorityBreakdown;
}

/**
 * Default effort estimates in minutes, by source. Effort is the smallest
 * weight in the formula — it breaks ties, it does not drive the ranking — so a
 * rough constant is honest and adequate. Replace with observed medians once
 * `workflow_approvals` has enough decided rows to compute them.
 */
const EFFORT_MINUTES: Record<QueueSource, number> = {
  workflow_exception: 30,
  workflow_approval: 15,
  // Reading a fleet signal is quick; the decision it forces is the point.
  drift_signal: 10,
  gap_finding: 60,
  accuracy_finding: 45,
  content_approval: 30,
  task_overdue: 30,
  // Unblocking usually means a decision (reschedule, re-baseline, cancel),
  // not a build — but a stalled experiment stalls the client's proof.
  intervention_blocked: 20,
};

/** Risk exposure by exception kind — legal/privacy/publication weight. */
const RISK_BY_KIND: Partial<Record<ExceptionKind | string, number>> = {
  evidence_conflict: 0.9,
  publication_failure: 0.8,
  compliance_approval: 1.0,
  adversarial_issue: 0.9,
  attribution_ambiguity: 0.6,
  client_approval: 0.5,
  renewal_risk: 0.7,
  cost_anomaly: 0.4,
  failed_workflow: 0.3,
  low_confidence_classification: 0.3,
  safe_stop: 0.4,
};

const SEVERITY_FROM_TEXT: Record<string, RiskLevel> = {
  critical: "critical",
  high: "high",
  medium: "medium",
  low: "low",
};

function hoursUntil(due: Date | null): number | null {
  if (!due) return null;
  return (due.getTime() - Date.now()) / 3_600_000;
}

export interface QueueOptions {
  /** Restrict to one client; omit for the whole portfolio. */
  projectId?: string;
  limit?: number;
}

export async function actionRequiredQueue(options: QueueOptions = {}): Promise<QueueItem[]> {
  const limit = options.limit ?? 100;
  const projectFilter = options.projectId ?? null;

  // Client value is a portfolio-relative input: a client we spend more on is a
  // client with more at stake. Computed once and shared across every item.
  const clientValue = await clientValueIndex();

  const items: QueueItem[] = [];

  // One round-trip wave, not six (perf pass 2026-08-04): the sources are
  // independent reads, and the page's latency was their sum — measured
  // ~420ms warm before, dominated by serial query time.
  const [exceptions, approvals, gaps, accuracy, content, overdueTasks, drift, blockedInterventions] =
    await Promise.all([
      sql`
        select e.id, e.project_id, e.kind, e.severity, e.summary, e.recommended_action,
          e.due_at, e.created_at, e.workflow_run_id, p.name as project_name
        from workflow_exceptions e
        left join projects p on p.id = e.project_id
        where e.status in ('open', 'acknowledged')
          ${projectFilter ? sql`and e.project_id = ${projectFilter}` : sql``}
        order by e.created_at desc
        limit ${limit}
      `,
      sql`
        select a.id, a.project_id, a.action_type, a.risk_level, a.summary, a.due_at,
          a.requested_at, a.workflow_run_id, p.name as project_name
        from workflow_approvals a
        left join projects p on p.id = a.project_id
        where a.decision is null
          ${projectFilter ? sql`and a.project_id = ${projectFilter}` : sql``}
        order by a.requested_at asc
        limit ${limit}
      `,
      sql`
        select g.id, g.project_id, g.gap_type, g.finding, g.severity, g.opportunity_score,
          g.created_at, p.name as project_name
        from gap_findings g
        join projects p on p.id = g.project_id
        where g.status = 'open'
          ${projectFilter ? sql`and g.project_id = ${projectFilter}` : sql``}
        order by g.opportunity_score desc
        limit ${limit}
      `,
      sql`
        select a.id, a.project_id, a.kind, a.quote, a.severity, a.confidence,
          a.created_at, p.name as project_name
        from accuracy_findings a
        join projects p on p.id = a.project_id
        where a.status = 'open'
          ${projectFilter ? sql`and a.project_id = ${projectFilter}` : sql``}
        order by a.created_at desc
        limit ${limit}
      `,
      sql`
        select c.id, c.project_id, c.title, c.status, c.updated_at, p.name as project_name
        from content_assets c
        join projects p on p.id = c.project_id
        where c.status = 'verified'
          ${projectFilter ? sql`and c.project_id = ${projectFilter}` : sql``}
        order by c.updated_at asc
        limit ${limit}
      `,
      sql`
        -- due_date leaves the database as TEXT (the listProjectTasks
        -- convention): as a raw date column it round-trips into an Invalid
        -- Date via template interpolation — the bug the e2e suite caught
        -- TWICE (first in phase 5, again when this query was rewritten into
        -- the wave). The regression test below the fix this time.
        select t.id, t.project_id, t.title, t.priority as task_priority,
          to_char(t.due_date, 'YYYY-MM-DD') as due_date,
          t.created_at, p.name as project_name
        from tasks t
        join projects p on p.id = t.project_id
        where t.status in ('approved', 'in_progress')
          and t.due_date is not null and t.due_date < current_date
          ${projectFilter ? sql`and t.project_id = ${projectFilter}` : sql``}
        order by t.due_date asc
        limit ${limit}
      `,
      // Drift signals are fleet-level: no project filter — a provider
      // change is every client's problem at once (spec 053).
      sql`
        select d.id, d.kind, d.provider, d.metric, d.summary, d.detected_at
        from drift_signals d
        where d.status = 'open'
        order by d.detected_at desc
        limit ${limit}
      `,
      // Blocked interventions (spec 062): a stalled retest is a stalled
      // client proof — invisible until the lifecycle made it representable.
      sql`
        select i.id, i.project_id, i.title, i.blocked_reason,
          i.status_changed_at, p.name as project_name
        from interventions i
        join projects p on p.id = i.project_id
        where i.status = 'blocked' and i.archived_at is null
          ${projectFilter ? sql`and i.project_id = ${projectFilter}` : sql``}
        order by i.status_changed_at asc
        limit ${limit}
      `,
    ]);

  // 0. Drift signals — fleet-level, always at the front of the mind:
  // every client's numbers are suspect while one is open (spec 053).
  for (const row of drift) {
    items.push({
      id: row.id as string,
      source: "drift_signal",
      kind: row.kind as string,
      projectId: null,
      projectName: "Fleet",
      summary: row.summary as string,
      severity: "high",
      recommendedAction:
        "Investigate the provider before any client-facing narrative uses these deltas; acknowledge when understood.",
      dueAt: null,
      createdAt: row.detectedAt as Date,
      href: "/control-tower",
      priority: computePriority({
        severity: "high",
        hoursUntilDue: null,
        commercialValue: 1,
        dependencyImpact: 1,
        risk: 0.9,
        effortMinutes: EFFORT_MINUTES.drift_signal,
      }),
    });
  }

  // 1. Workflow exceptions -------------------------------------------------
  for (const row of exceptions) {
    const projectId = (row.projectId as string | null) ?? null;
    const severity = SEVERITY_FROM_TEXT[row.severity as string] ?? "medium";
    const dueAt = (row.dueAt as Date | null) ?? null;
    items.push({
      id: row.id as string,
      source: "workflow_exception",
      kind: row.kind as string,
      projectId,
      projectName: (row.projectName as string) ?? "—",
      summary: row.summary as string,
      recommendedAction: (row.recommendedAction as string) || "Review and resolve.",
      severity,
      dueAt,
      createdAt: row.createdAt as Date,
      href: row.workflowRunId ? `/workflows/${row.workflowRunId}` : "/control-tower",
      priority: computePriority({
        severity,
        hoursUntilDue: hoursUntil(dueAt),
        commercialValue: clientValue.get(projectId ?? "") ?? 0.3,
        dependencyImpact: row.workflowRunId ? 0.7 : 0.2,
        risk: RISK_BY_KIND[row.kind as string] ?? 0.3,
        effortMinutes: EFFORT_MINUTES.workflow_exception,
      }),
    });
  }

  // 2. Pending workflow approvals -----------------------------------------
  for (const row of approvals) {
    const projectId = (row.projectId as string | null) ?? null;
    const severity = SEVERITY_FROM_TEXT[row.riskLevel as string] ?? "medium";
    const dueAt = (row.dueAt as Date | null) ?? null;
    items.push({
      id: row.id as string,
      source: "workflow_approval",
      kind: row.actionType as string,
      projectId,
      projectName: (row.projectName as string) ?? "—",
      summary: row.summary as string,
      recommendedAction: "Approve or reject the prepared action.",
      severity,
      dueAt,
      createdAt: row.requestedAt as Date,
      // The inbox decides inline and picks the right run page per
      // definition — deep-linking the legacy run page dropped the automation
      // context (C2).
      href: "/approvals",
      // An approval blocks its whole workflow by construction — maximum
      // dependency impact is a fact here, not an estimate.
      priority: computePriority({
        severity,
        hoursUntilDue: hoursUntil(dueAt),
        commercialValue: clientValue.get(projectId ?? "") ?? 0.3,
        dependencyImpact: 1,
        risk: RISK_BY_KIND[row.actionType as string] ?? 0.5,
        effortMinutes: EFFORT_MINUTES.workflow_approval,
      }),
    });
  }

  // 3. Open gap findings — opportunity, not breakage ----------------------
  for (const row of gaps) {
    const projectId = row.projectId as string;
    const opportunity = Number(row.opportunityScore ?? 0);
    const severityScore = Number(row.severity ?? 0);
    const severity: RiskLevel =
      severityScore >= 0.75 ? "high" : severityScore >= 0.4 ? "medium" : "low";
    items.push({
      id: row.id as string,
      source: "gap_finding",
      kind: row.gapType as string,
      projectId,
      projectName: row.projectName as string,
      summary: row.finding as string,
      recommendedAction: "Turn into a content or profile action, or dismiss with a reason.",
      severity,
      dueAt: null,
      createdAt: row.createdAt as Date,
      href: `/projects/${projectId}/gaps`,
      priority: computePriority({
        severity,
        hoursUntilDue: null,
        // Opportunity score IS the commercial-value estimate (spec 009).
        commercialValue: Math.min(1, opportunity),
        dependencyImpact: 0.1,
        risk: 0.1,
        effortMinutes: EFFORT_MINUTES.gap_finding,
      }),
    });
  }

  // 4. Open accuracy findings — a live factual problem ---------------------
  for (const row of accuracy) {
    const projectId = row.projectId as string;
    const severity = SEVERITY_FROM_TEXT[row.severity as string] ?? "medium";
    items.push({
      id: row.id as string,
      source: "accuracy_finding",
      kind: row.kind as string,
      projectId,
      projectName: row.projectName as string,
      summary: `AI answers state: "${String(row.quote).slice(0, 140)}"`,
      recommendedAction: "Correct the underlying public evidence, then re-measure.",
      severity,
      dueAt: null,
      createdAt: row.createdAt as Date,
      href: `/projects/${projectId}/accuracy`,
      priority: computePriority({
        severity,
        hoursUntilDue: null,
        commercialValue: clientValue.get(projectId) ?? 0.3,
        dependencyImpact: 0.2,
        // A wrong fact in front of buyers is reputational exposure now.
        risk: 0.85,
        effortMinutes: EFFORT_MINUTES.accuracy_finding,
      }),
    });
  }

  // 5. Content waiting on approval ----------------------------------------
  for (const row of content) {
    const projectId = row.projectId as string;
    items.push({
      id: row.id as string,
      source: "content_approval",
      kind: "content_asset",
      projectId,
      projectName: row.projectName as string,
      summary: `"${row.title}" is verified and waiting for approval`,
      recommendedAction: "Review the verified draft and approve or send it back.",
      severity: "medium",
      dueAt: null,
      createdAt: row.updatedAt as Date,
      href: `/projects/${projectId}/content/${row.id}`,
      priority: computePriority({
        severity: "medium",
        hoursUntilDue: null,
        commercialValue: clientValue.get(projectId) ?? 0.3,
        dependencyImpact: 0.6,
        risk: 0.4,
        effortMinutes: EFFORT_MINUTES.content_approval,
      }),
    });
  }

  // 6. Overdue tasks — committed work slipping (plan 5.3). The queue that
  // answers "what first?" could not see the work items until now.
  for (const row of overdueTasks) {
    const projectId = row.projectId as string;
    const severity: RiskLevel = row.taskPriority === "p1" ? "high" : "medium";
    const dueAt = new Date(`${row.dueDate as string}T00:00:00Z`);
    items.push({
      id: row.id as string,
      source: "task_overdue",
      kind: `${row.taskPriority} task`,
      projectId,
      projectName: row.projectName as string,
      summary: `Overdue: "${row.title}"`,
      recommendedAction: "Finish it, move the due date with the client, or drop it explicitly.",
      severity,
      dueAt,
      createdAt: row.createdAt as Date,
      href: `/projects/${projectId}/tasks`,
      priority: computePriority({
        severity,
        hoursUntilDue: hoursUntil(dueAt),
        commercialValue: clientValue.get(projectId) ?? 0.3,
        dependencyImpact: 0.3,
        risk: 0.2,
        effortMinutes: EFFORT_MINUTES.task_overdue,
      }),
    });
  }

  // 7. Blocked interventions — a stalled retest, invisible before spec 062 --
  for (const row of blockedInterventions) {
    const projectId = row.projectId as string;
    items.push({
      id: row.id as string,
      source: "intervention_blocked",
      kind: "intervention",
      projectId,
      projectName: row.projectName as string,
      summary: `Blocked: "${row.title}" — ${row.blockedReason as string}`,
      recommendedAction:
        "Resolve the blocker and unblock, or cancel the measurement explicitly.",
      severity: "high",
      dueAt: null,
      createdAt: row.statusChangedAt as Date,
      href: `/projects/${projectId}/interventions/${row.id}`,
      priority: computePriority({
        severity: "high",
        hoursUntilDue: null,
        commercialValue: clientValue.get(projectId) ?? 0.3,
        // A blocked retest holds up the verdict every downstream narrative
        // depends on.
        dependencyImpact: 0.7,
        risk: 0.4,
        effortMinutes: EFFORT_MINUTES.intervention_blocked,
      }),
    });
  }

  return items.sort((a, b) => b.priority.total - a.priority.total).slice(0, limit);
}

/**
 * Normalised 0..1 client value. Contract value (migration 056) is the real
 * commercial signal and wins when the operator recorded one; projects
 * without it fall back to 30-day provider spend, the only signal the
 * platform holds on its own. The two scales are normalised separately —
 * approximate, and better than pretending spend is revenue.
 */
export async function clientValueIndex(): Promise<Map<string, number>> {
  const contracts = await sql`
    select id as project_id, contract_value_usd from projects
    where contract_value_usd is not null and status = 'active'
  `;
  const spendRows = await sql`
    select project_id, coalesce(sum(cost_usd), 0) as spend
    from runs
    where started_at >= now() - interval '30 days'
    group by project_id
  `;
  const map = new Map<string, number>();
  const maxContract = Math.max(1, ...contracts.map((r) => Number(r.contractValueUsd)));
  for (const row of contracts) {
    map.set(row.projectId as string, Number(row.contractValueUsd) / maxContract);
  }
  const maxSpend = Math.max(1, ...spendRows.map((r) => Number(r.spend ?? 0)));
  for (const row of spendRows) {
    const id = row.projectId as string;
    if (!map.has(id)) map.set(id, Number(row.spend ?? 0) / maxSpend);
  }
  return map;
}
