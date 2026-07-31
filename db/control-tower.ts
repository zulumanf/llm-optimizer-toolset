/**
 * Cross-client reads for the operator console (spec 019).
 *
 * This is the one module allowed to query across every client, because it
 * serves the one screen whose job is the portfolio. Node handlers and agent
 * paths never import it — their scope is a single project by construction.
 */
import { sql } from "@/db/client";
import { criticalPath, parallelizableShare } from "@/lib/workflow/graph";
import type { NodeRun, WorkflowDefinition, WorkflowState } from "@/lib/workflow/types";

export interface PortfolioMetrics {
  activeClients: number;
  onboardingClients: number;
  atRiskClients: number;
  workflowsRunning: number;
  workflowsBlocked: number;
  approvalsPending: number;
  approvalsOverdue: number;
  openExceptions: number;
  criticalExceptions: number;
  safeStops7d: number;
  failedRuns7d: number;
}

export async function portfolioMetrics(): Promise<PortfolioMetrics> {
  const [row] = await sql`
    select
      (select count(*) from projects where status = 'active') as active_clients,
      (select count(*) from projects p where p.status = 'active'
         and not exists (select 1 from runs r where r.project_id = p.id)) as onboarding_clients,
      (select count(distinct project_id) from workflow_exceptions
         where status in ('open','acknowledged') and severity in ('high','critical')
         and project_id is not null) as at_risk_clients,
      (select count(*) from workflow_runs
         where state in ('running','initializing','queued')) as workflows_running,
      (select count(*) from workflow_runs
         where state in ('waiting_for_approval','waiting_for_dependency',
           'waiting_for_external_system','safely_stopped')) as workflows_blocked,
      (select count(*) from workflow_approvals where decision is null) as approvals_pending,
      (select count(*) from workflow_approvals
         where decision is null and due_at < now()) as approvals_overdue,
      (select count(*) from workflow_exceptions
         where status in ('open','acknowledged')) as open_exceptions,
      (select count(*) from workflow_exceptions
         where status in ('open','acknowledged') and severity = 'critical') as critical_exceptions,
      (select count(*) from workflow_runs
         where state = 'safely_stopped' and started_at >= now() - interval '7 days') as safe_stops_7d,
      (select count(*) from runs
         where status = 'failed' and started_at >= now() - interval '7 days') as failed_runs_7d
  `;
  const n = (key: string): number => Number((row as Record<string, unknown>)?.[key] ?? 0);
  return {
    activeClients: n("activeClients"),
    onboardingClients: n("onboardingClients"),
    atRiskClients: n("atRiskClients"),
    workflowsRunning: n("workflowsRunning"),
    workflowsBlocked: n("workflowsBlocked"),
    approvalsPending: n("approvalsPending"),
    approvalsOverdue: n("approvalsOverdue"),
    openExceptions: n("openExceptions"),
    criticalExceptions: n("criticalExceptions"),
    safeStops7d: n("safeStops7d"),
    failedRuns7d: n("failedRuns7d"),
  };
}

export interface WorkflowRunSummary {
  id: string;
  definitionKey: string;
  definitionName: string;
  version: number;
  projectId: string | null;
  projectName: string | null;
  state: WorkflowState;
  stopReason: string | null;
  nodeCounts: { succeeded: number; failed: number; running: number; waiting: number };
  costMicroUsd: number;
  startedAt: Date;
  finishedAt: Date | null;
}

export async function listWorkflowRuns(options: {
  projectId?: string;
  limit?: number;
} = {}): Promise<WorkflowRunSummary[]> {
  const rows = await sql`
    select r.id, r.project_id, r.state, r.stop_reason, r.cost_micro_usd,
      r.started_at, r.finished_at, d.key as definition_key, d.name as definition_name,
      v.version, p.name as project_name,
      (select count(*) from node_runs n where n.workflow_run_id = r.id and n.state = 'succeeded') as succeeded,
      (select count(*) from node_runs n where n.workflow_run_id = r.id and n.state in ('failed_terminal','timed_out')) as failed,
      (select count(*) from node_runs n where n.workflow_run_id = r.id and n.state = 'running') as running,
      (select count(*) from node_runs n where n.workflow_run_id = r.id and n.state in ('awaiting_approval','awaiting_verification','failed_retryable')) as waiting
    from workflow_runs r
    join workflow_versions v on v.id = r.version_id
    join workflow_definitions d on d.id = v.definition_id
    left join projects p on p.id = r.project_id
    where true ${options.projectId ? sql`and r.project_id = ${options.projectId}` : sql``}
    order by r.started_at desc
    limit ${options.limit ?? 50}
  `;
  return rows.map((row) => ({
    id: row.id as string,
    definitionKey: row.definitionKey as string,
    definitionName: row.definitionName as string,
    version: Number(row.version),
    projectId: (row.projectId as string | null) ?? null,
    projectName: (row.projectName as string | null) ?? null,
    state: row.state as WorkflowState,
    stopReason: (row.stopReason as string | null) ?? null,
    nodeCounts: {
      succeeded: Number(row.succeeded),
      failed: Number(row.failed),
      running: Number(row.running),
      waiting: Number(row.waiting),
    },
    costMicroUsd: Number(row.costMicroUsd ?? 0),
    startedAt: row.startedAt as Date,
    finishedAt: (row.finishedAt as Date | null) ?? null,
  }));
}

export interface WorkflowRunDetail {
  run: WorkflowRunSummary;
  spec: WorkflowDefinition;
  nodes: (NodeRun & { durationMs: number | null })[];
  transitions: {
    at: Date;
    scope: string;
    nodeKey: string | null;
    fromState: string | null;
    toState: string;
    actor: string;
    reason: string;
  }[];
  approvals: {
    id: string;
    summary: string;
    riskLevel: string;
    requiredRole: string;
    decision: string | null;
    rationale: string | null;
    requestedAt: Date;
    dueAt: Date | null;
    nodeRunId: string;
  }[];
  gates: { gateType: string; outcome: string; checks: unknown; evaluatedAt: Date }[];
  timing: {
    totalNodeMs: number;
    criticalPath: string[];
    criticalPathMs: number;
    parallelizableShare: number;
  };
}

export async function workflowRunDetail(runId: string): Promise<WorkflowRunDetail | null> {
  const [summary] = await sql`
    select r.id, r.project_id, r.state, r.stop_reason, r.cost_micro_usd,
      r.started_at, r.finished_at, r.version_id, d.key as definition_key,
      d.name as definition_name, v.version, v.spec, p.name as project_name
    from workflow_runs r
    join workflow_versions v on v.id = r.version_id
    join workflow_definitions d on d.id = v.definition_id
    left join projects p on p.id = r.project_id
    where r.id = ${runId}
  `;
  if (!summary) return null;

  const nodeRows = await sql`
    select * from node_runs where workflow_run_id = ${runId} order by created_at asc
  `;
  const nodes = nodeRows.map((row) => {
    const started = row.startedAt as Date | null;
    const finished = row.finishedAt as Date | null;
    return {
      id: row.id as string,
      workflowRunId: runId,
      nodeId: row.nodeId as string,
      nodeKey: row.nodeKey as string,
      fanKey: row.fanKey as string,
      state: row.state as NodeRun["state"],
      attempts: Number(row.attempts),
      input: (row.input as Record<string, unknown> | null) ?? null,
      output: (row.output as Record<string, unknown> | null) ?? null,
      confidence: row.confidence === null ? null : Number(row.confidence),
      costMicroUsd: Number(row.costMicroUsd ?? 0),
      error: (row.error as string | null) ?? null,
      humanTouch: Boolean(row.humanTouch),
      nextAttemptAt: (row.nextAttemptAt as Date | null) ?? null,
      startedAt: started,
      finishedAt: finished,
      durationMs: started && finished ? finished.getTime() - started.getTime() : null,
    };
  });

  const transitionRows = await sql`
    select at, scope, node_version, from_state, to_state, actor, reason
    from workflow_transitions where workflow_run_id = ${runId}
    order by at asc, id asc
  `;
  const approvalRows = await sql`
    select id, summary, risk_level, required_role, decision, rationale,
      requested_at, due_at, node_run_id
    from workflow_approvals where workflow_run_id = ${runId}
    order by requested_at asc
  `;
  const gateRows = await sql`
    select gate_type, outcome, checks, evaluated_at
    from quality_gate_results where workflow_run_id = ${runId}
    order by evaluated_at asc
  `;

  const spec = summary.spec as WorkflowDefinition;
  const timed = nodes
    .filter((n) => n.durationMs !== null)
    .map((n) => ({ nodeKey: n.nodeKey, fanKey: n.fanKey, durationMs: n.durationMs! }));
  const cp = criticalPath(spec, timed);
  const totalNodeMs = timed.reduce((sum, t) => sum + t.durationMs, 0);

  return {
    run: {
      id: summary.id as string,
      definitionKey: summary.definitionKey as string,
      definitionName: summary.definitionName as string,
      version: Number(summary.version),
      projectId: (summary.projectId as string | null) ?? null,
      projectName: (summary.projectName as string | null) ?? null,
      state: summary.state as WorkflowState,
      stopReason: (summary.stopReason as string | null) ?? null,
      nodeCounts: {
        succeeded: nodes.filter((n) => n.state === "succeeded").length,
        failed: nodes.filter((n) => n.state === "failed_terminal" || n.state === "timed_out").length,
        running: nodes.filter((n) => n.state === "running").length,
        waiting: nodes.filter(
          (n) =>
            n.state === "awaiting_approval" ||
            n.state === "awaiting_verification" ||
            n.state === "failed_retryable"
        ).length,
      },
      costMicroUsd: Number(summary.costMicroUsd ?? 0),
      startedAt: summary.startedAt as Date,
      finishedAt: (summary.finishedAt as Date | null) ?? null,
    },
    spec,
    nodes,
    transitions: transitionRows.map((r) => ({
      at: r.at as Date,
      scope: r.scope as string,
      nodeKey: (r.nodeVersion as string | null) ?? null,
      fromState: (r.fromState as string | null) ?? null,
      toState: r.toState as string,
      actor: r.actor as string,
      reason: (r.reason as string) ?? "",
    })),
    approvals: approvalRows.map((r) => ({
      id: r.id as string,
      summary: r.summary as string,
      riskLevel: r.riskLevel as string,
      requiredRole: r.requiredRole as string,
      decision: (r.decision as string | null) ?? null,
      rationale: (r.rationale as string | null) ?? null,
      requestedAt: r.requestedAt as Date,
      dueAt: (r.dueAt as Date | null) ?? null,
      nodeRunId: r.nodeRunId as string,
    })),
    gates: gateRows.map((r) => ({
      gateType: r.gateType as string,
      outcome: r.outcome as string,
      checks: r.checks,
      evaluatedAt: r.evaluatedAt as Date,
    })),
    timing: {
      totalNodeMs,
      criticalPath: cp.path,
      criticalPathMs: cp.durationMs,
      parallelizableShare: parallelizableShare(totalNodeMs, cp.durationMs),
    },
  };
}

/** Latest health snapshot per active client, for the control tower table. */
export async function latestHealthByClient(): Promise<
  {
    projectId: string;
    projectName: string;
    overall: number | null;
    confidence: number;
    periodEnd: Date;
    components: { name: string; weight: number; score: number | null; detail: string }[];
    missing: string[];
  }[]
> {
  const rows = await sql`
    select distinct on (h.project_id)
      h.project_id, h.overall, h.confidence, h.period_end, h.components, h.missing,
      p.name as project_name
    from client_health_snapshots h
    join projects p on p.id = h.project_id
    where p.status = 'active'
    order by h.project_id, h.period_end desc, h.computed_at desc
  `;
  return rows.map((r) => ({
    projectId: r.projectId as string,
    projectName: r.projectName as string,
    overall: r.overall === null ? null : Number(r.overall),
    confidence: Number(r.confidence ?? 0),
    periodEnd: r.periodEnd as Date,
    components: (r.components as {
      name: string;
      weight: number;
      score: number | null;
      detail: string;
    }[]) ?? [],
    missing: (r.missing as string[]) ?? [],
  }));
}
