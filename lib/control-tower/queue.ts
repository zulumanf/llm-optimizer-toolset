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
  | "gap_finding"
  | "accuracy_finding"
  | "content_approval";

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
  gap_finding: 60,
  accuracy_finding: 45,
  content_approval: 30,
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

  // 1. Workflow exceptions -------------------------------------------------
  const exceptions = await sql`
    select e.id, e.project_id, e.kind, e.severity, e.summary, e.recommended_action,
      e.due_at, e.created_at, e.workflow_run_id, p.name as project_name
    from workflow_exceptions e
    left join projects p on p.id = e.project_id
    where e.status in ('open', 'acknowledged')
      ${projectFilter ? sql`and e.project_id = ${projectFilter}` : sql``}
    order by e.created_at desc
    limit ${limit}
  `;
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
  const approvals = await sql`
    select a.id, a.project_id, a.action_type, a.risk_level, a.summary, a.due_at,
      a.requested_at, a.workflow_run_id, p.name as project_name
    from workflow_approvals a
    left join projects p on p.id = a.project_id
    where a.decision is null
      ${projectFilter ? sql`and a.project_id = ${projectFilter}` : sql``}
    order by a.requested_at asc
    limit ${limit}
  `;
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
      href: `/workflows/${row.workflowRunId}`,
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
  const gaps = await sql`
    select g.id, g.project_id, g.gap_type, g.finding, g.severity, g.opportunity_score,
      g.created_at, p.name as project_name
    from gap_findings g
    join projects p on p.id = g.project_id
    where g.status = 'open'
      ${projectFilter ? sql`and g.project_id = ${projectFilter}` : sql``}
    order by g.opportunity_score desc
    limit ${limit}
  `;
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
  const accuracy = await sql`
    select a.id, a.project_id, a.kind, a.quote, a.severity, a.confidence,
      a.created_at, p.name as project_name
    from accuracy_findings a
    join projects p on p.id = a.project_id
    where a.status = 'open'
      ${projectFilter ? sql`and a.project_id = ${projectFilter}` : sql``}
    order by a.created_at desc
    limit ${limit}
  `;
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
  const content = await sql`
    select c.id, c.project_id, c.title, c.status, c.updated_at, p.name as project_name
    from content_assets c
    join projects p on p.id = c.project_id
    where c.status = 'verified'
      ${projectFilter ? sql`and c.project_id = ${projectFilter}` : sql``}
    order by c.updated_at asc
    limit ${limit}
  `;
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

  return items.sort((a, b) => b.priority.total - a.priority.total).slice(0, limit);
}

/**
 * Normalised 0..1 client value, from 30-day provider spend. Spend is the only
 * commercial signal the platform actually holds today — there is no contract
 * value in the schema — so it is used honestly and labelled as what it is.
 */
export async function clientValueIndex(): Promise<Map<string, number>> {
  const rows = await sql`
    select project_id, coalesce(sum(cost_usd), 0) as spend
    from runs
    where started_at >= now() - interval '30 days'
    group by project_id
  `;
  const values = rows.map((r) => Number(r.spend ?? 0));
  const max = Math.max(1, ...values);
  const map = new Map<string, number>();
  for (const row of rows) {
    map.set(row.projectId as string, Number(row.spend ?? 0) / max);
  }
  return map;
}
