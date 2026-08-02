/**
 * Automation observability.
 *
 * Every number here is computed from durable rows, so any figure the UI shows
 * can be drilled into. Where a number would require data we do not have, this
 * module returns `null` and the UI says so — most visibly for labour savings,
 * which the request asks for only when a real baseline exists. None does, so it
 * is not estimated.
 */
import { sql } from "@/db/client";

export interface WorkflowMetrics {
  workflowKey: string;
  runs: number;
  completed: number;
  partiallyCompleted: number;
  safelyStopped: number;
  failed: number;
  waitingForApproval: number;
  completionRate: number;
  safeStopRate: number;
  failureRate: number;
  avgDurationSeconds: number | null;
  avgCostMicroUsd: number;
  /** Share of runs where a human had to touch a node. The honest automation number. */
  manualInterventionRate: number;
  testRuns: number;
}

export async function workflowMetrics(): Promise<WorkflowMetrics[]> {
  const rows = await sql`
    select d.key as workflow_key,
      count(r.id) filter (where r.mode = 'live')::int as runs,
      count(r.id) filter (where r.mode = 'live' and r.state = 'completed')::int as completed,
      count(r.id) filter (where r.mode = 'live' and r.state = 'partially_completed')::int as partial,
      count(r.id) filter (where r.mode = 'live' and r.state = 'safely_stopped')::int as safely_stopped,
      count(r.id) filter (where r.mode = 'live' and r.state in ('failed','timed_out'))::int as failed,
      count(r.id) filter (where r.state = 'waiting_for_approval')::int as waiting,
      count(r.id) filter (where r.mode = 'test')::int as test_runs,
      avg(extract(epoch from (r.finished_at - r.started_at)))
        filter (where r.finished_at is not null and r.mode = 'live') as avg_duration,
      coalesce(avg(r.cost_micro_usd) filter (where r.mode = 'live'), 0)::int as avg_cost,
      count(distinct r.id) filter (
        where r.mode = 'live' and exists (
          select 1 from node_runs n where n.workflow_run_id = r.id and n.human_touch
        )
      )::int as human_touched
    from workflow_definitions d
    left join workflow_versions v on v.definition_id = d.id
    left join workflow_runs r on r.version_id = v.id
    group by d.key
    order by d.key
  `;

  return rows.map((row) => {
    const runs = Number(row.runs ?? 0);
    const rate = (n: unknown): number => (runs === 0 ? 0 : Number(n ?? 0) / runs);
    return {
      workflowKey: row.workflowKey as string,
      runs,
      completed: Number(row.completed ?? 0),
      partiallyCompleted: Number(row.partial ?? 0),
      safelyStopped: Number(row.safelyStopped ?? 0),
      failed: Number(row.failed ?? 0),
      waitingForApproval: Number(row.waiting ?? 0),
      completionRate: rate(row.completed),
      safeStopRate: rate(row.safelyStopped),
      failureRate: rate(row.failed),
      avgDurationSeconds: row.avgDuration === null ? null : Math.round(Number(row.avgDuration)),
      avgCostMicroUsd: Number(row.avgCost ?? 0),
      manualInterventionRate: rate(row.humanTouched),
      testRuns: Number(row.testRuns ?? 0),
    };
  });
}

export interface AgentMetrics {
  agentVersion: string;
  invocations: number;
  schemaFailures: number;
  avgConfidence: number | null;
  belowThreshold: number;
  humanOverrides: number;
  avgCostMicroUsd: number;
  avgLatencySeconds: number | null;
}

export async function agentMetrics(): Promise<AgentMetrics[]> {
  const rows = await sql`
    select n.agent_version,
      count(nr.id)::int as invocations,
      count(nr.id) filter (where nr.state = 'failed_terminal')::int as schema_failures,
      avg(nr.confidence) as avg_confidence,
      count(nr.id) filter (
        where nr.confidence is not null and n.confidence_threshold is not null
          and nr.confidence < n.confidence_threshold
      )::int as below_threshold,
      count(nr.id) filter (where nr.human_touch)::int as human_overrides,
      coalesce(avg(nr.cost_micro_usd), 0)::int as avg_cost,
      avg(extract(epoch from (nr.finished_at - nr.started_at))) as avg_latency
    from workflow_nodes n
    join node_runs nr on nr.node_id = n.id
    where n.agent_version is not null
    group by n.agent_version
    order by count(nr.id) desc
  `;
  return rows.map((row) => ({
    agentVersion: row.agentVersion as string,
    invocations: Number(row.invocations ?? 0),
    schemaFailures: Number(row.schemaFailures ?? 0),
    avgConfidence: row.avgConfidence === null ? null : Number(row.avgConfidence),
    belowThreshold: Number(row.belowThreshold ?? 0),
    humanOverrides: Number(row.humanOverrides ?? 0),
    avgCostMicroUsd: Number(row.avgCost ?? 0),
    avgLatencySeconds: row.avgLatency === null ? null : Math.round(Number(row.avgLatency)),
  }));
}

export interface BusinessMetrics {
  clients: number;
  openExceptions: number;
  overdueExceptions: number;
  pendingApprovals: number;
  overdueApprovals: number;
  exceptionsPerClient: number | null;
  approvalsPerClient: number | null;
  /** Median hours from approval request to decision. Null with no decisions. */
  medianApprovalHours: number | null;
  activeSequences: number;
  suppressedContacts: number;
  /**
   * Deliberately null. Reporting a labour saving needs a measured manual
   * baseline, and none exists — an invented figure here would be the exact kind
   * of unsupported claim this platform exists to prevent.
   */
  humanTimeSavedHours: null;
}

export async function businessMetrics(): Promise<BusinessMetrics> {
  const [row] = await sql`
    select
      (select count(*)::int from projects
        where status = 'active' and kind = 'client') as clients,
      (select count(*)::int from workflow_exceptions
        where status in ('open','acknowledged')) as open_exceptions,
      (select count(*)::int from workflow_exceptions
        where status in ('open','acknowledged') and due_at < now()) as overdue_exceptions,
      (select count(*)::int from workflow_approvals where decision is null) as pending_approvals,
      (select count(*)::int from workflow_approvals
        where decision is null and due_at < now()) as overdue_approvals,
      (select percentile_cont(0.5) within group (
        order by extract(epoch from (decided_at - requested_at)) / 3600.0
      ) from workflow_approvals where decided_at is not null) as median_approval_hours,
      (select count(*)::int from outreach_sequences where status = 'active') as active_sequences,
      (select count(*)::int from suppression_entries where lifted_at is null) as suppressed
  `;
  const clients = Number(row?.clients ?? 0);
  const openExceptions = Number(row?.openExceptions ?? 0);
  const pendingApprovals = Number(row?.pendingApprovals ?? 0);

  return {
    clients,
    openExceptions,
    overdueExceptions: Number(row?.overdueExceptions ?? 0),
    pendingApprovals,
    overdueApprovals: Number(row?.overdueApprovals ?? 0),
    // Per-client averages are meaningless with no clients; null, not zero.
    exceptionsPerClient: clients === 0 ? null : openExceptions / clients,
    approvalsPerClient: clients === 0 ? null : pendingApprovals / clients,
    medianApprovalHours:
      row?.medianApprovalHours === null || row?.medianApprovalHours === undefined
        ? null
        : Math.round(Number(row.medianApprovalHours) * 10) / 10,
    activeSequences: Number(row?.activeSequences ?? 0),
    suppressedContacts: Number(row?.suppressed ?? 0),
    humanTimeSavedHours: null,
  };
}

export interface RunSummary {
  id: string;
  workflowKey: string;
  workflowVersion: number;
  projectId: string | null;
  projectName: string | null;
  state: string;
  mode: string;
  trigger: string;
  costMicroUsd: number;
  startedAt: Date;
  finishedAt: Date | null;
  nodeCount: number;
  failedNodes: number;
  pendingApprovals: number;
}

export async function recentRuns(filters?: {
  mode?: "live" | "test";
  workflowKey?: string;
  limit?: number;
}): Promise<RunSummary[]> {
  const rows = await sql`
    select r.id, d.key as workflow_key, v.version as workflow_version, r.project_id,
           p.name as project_name, r.state, r.mode, r.trigger, r.cost_micro_usd,
           r.started_at, r.finished_at,
           (select count(*)::int from node_runs n where n.workflow_run_id = r.id) as node_count,
           (select count(*)::int from node_runs n
             where n.workflow_run_id = r.id and n.state = 'failed_terminal') as failed_nodes,
           (select count(*)::int from workflow_approvals a
             where a.workflow_run_id = r.id and a.decision is null) as pending_approvals
    from workflow_runs r
    join workflow_versions v on v.id = r.version_id
    join workflow_definitions d on d.id = v.definition_id
    left join projects p on p.id = r.project_id
    where (${filters?.mode ?? null}::text is null or r.mode = ${filters?.mode ?? null})
      and (${filters?.workflowKey ?? null}::text is null or d.key = ${filters?.workflowKey ?? null})
    order by r.started_at desc
    limit ${Math.min(filters?.limit ?? 50, 200)}
  `;
  return rows.map((row) => ({
    id: row.id as string,
    workflowKey: row.workflowKey as string,
    workflowVersion: Number(row.workflowVersion ?? 1),
    projectId: (row.projectId as string | null) ?? null,
    projectName: (row.projectName as string | null) ?? null,
    state: row.state as string,
    mode: row.mode as string,
    trigger: row.trigger as string,
    costMicroUsd: Number(row.costMicroUsd ?? 0),
    startedAt: row.startedAt as Date,
    finishedAt: (row.finishedAt as Date | null) ?? null,
    nodeCount: Number(row.nodeCount ?? 0),
    failedNodes: Number(row.failedNodes ?? 0),
    pendingApprovals: Number(row.pendingApprovals ?? 0),
  }));
}

export interface NodeRunDetail {
  id: string;
  nodeKey: string;
  nodeName: string;
  nodeType: string;
  handler: string | null;
  fanKey: string;
  state: string;
  attempts: number;
  confidence: number | null;
  costMicroUsd: number;
  humanTouch: boolean;
  error: string | null;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  durationSeconds: number | null;
}

export async function nodeRunsForRun(runId: string): Promise<NodeRunDetail[]> {
  const rows = await sql`
    select nr.*, n.name as node_name, n.node_type, n.handler,
           extract(epoch from (nr.finished_at - nr.started_at)) as duration
    from node_runs nr
    join workflow_nodes n on n.id = nr.node_id
    where nr.workflow_run_id = ${runId}
    order by nr.created_at asc
  `;
  return rows.map((row) => ({
    id: row.id as string,
    nodeKey: row.nodeKey as string,
    nodeName: (row.nodeName as string) ?? "",
    nodeType: (row.nodeType as string) ?? "",
    handler: (row.handler as string | null) ?? null,
    fanKey: (row.fanKey as string) ?? "",
    state: row.state as string,
    attempts: Number(row.attempts ?? 0),
    confidence: row.confidence === null ? null : Number(row.confidence),
    costMicroUsd: Number(row.costMicroUsd ?? 0),
    humanTouch: Boolean(row.humanTouch),
    error: (row.error as string | null) ?? null,
    input: (row.input as Record<string, unknown> | null) ?? null,
    output: (row.output as Record<string, unknown> | null) ?? null,
    startedAt: (row.startedAt as Date | null) ?? null,
    finishedAt: (row.finishedAt as Date | null) ?? null,
    durationSeconds: row.duration === null ? null : Math.round(Number(row.duration)),
  }));
}
