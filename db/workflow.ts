/**
 * All SQL for the workflow graph (spec 018). Nothing outside this module
 * touches the workflow_* / node_runs tables — the same rule the rest of db/
 * follows (docs/02).
 *
 * Tenant scoping note: every read that can span clients takes an explicit
 * projectId filter. There is no "all projects" accessor that a node handler
 * can reach; the cross-client views live in db/control-tower.ts and are only
 * called from the operator console.
 */
import { sql, type TransactionSql } from "@/db/client";
import type {
  EdgeCondition,
  NodeDefinition,
  NodeRun,
  NodeState,
  WorkflowDefinition,
  WorkflowRun,
  WorkflowState,
} from "@/lib/workflow/types";

type Tx = TransactionSql | typeof sql;

// ------------------------------------------------------------- definitions

export interface StoredVersion {
  versionId: string;
  definitionId: string;
  version: number;
  graphHash: string;
  created: boolean;
}

export async function upsertDefinition(
  tx: Tx,
  def: WorkflowDefinition
): Promise<string> {
  const [row] = await tx`
    insert into workflow_definitions (key, name, description, autonomy_level, action_type)
    values (${def.key}, ${def.name}, ${def.description}, ${def.autonomyLevel}, ${def.actionType})
    on conflict (key) do update set
      name = excluded.name,
      description = excluded.description,
      autonomy_level = excluded.autonomy_level,
      action_type = excluded.action_type,
      updated_at = now()
    returning id
  `;
  return row!.id as string;
}

export async function findVersionByHash(
  tx: Tx,
  definitionId: string,
  graphHash: string
): Promise<{ versionId: string; version: number } | null> {
  const [row] = await tx`
    select id, version from workflow_versions
    where definition_id = ${definitionId} and graph_hash = ${graphHash}
  `;
  return row ? { versionId: row.id as string, version: row.version as number } : null;
}

export async function insertVersion(
  tx: Tx,
  args: {
    definitionId: string;
    graphHash: string;
    def: WorkflowDefinition;
    createdBy: string | null;
  }
): Promise<{ versionId: string; version: number }> {
  const [max] = await tx`
    select coalesce(max(version), 0) as v from workflow_versions
    where definition_id = ${args.definitionId}
  `;
  const version = (Number(max?.v ?? 0) || 0) + 1;
  const [row] = await tx`
    insert into workflow_versions (definition_id, version, graph_hash, spec, created_by)
    values (${args.definitionId}, ${version}, ${args.graphHash},
      ${tx.json(args.def as never)}, ${args.createdBy})
    returning id
  `;
  const versionId = row!.id as string;

  for (const node of args.def.nodes) {
    await tx`
      insert into workflow_nodes (
        version_id, node_key, node_type, name, description, handler, agent_version,
        allowed_tools, required_evidence, confidence_threshold, timeout_seconds,
        max_attempts, retry_backoff_seconds, risk_level, requires_approval,
        approval_role, idempotency_strategy, failure_strategy, autonomy_level, config
      ) values (
        ${versionId}, ${node.key}, ${node.type}, ${node.name}, ${node.description ?? ""},
        ${node.handler ?? null}, ${node.agentVersion ?? null},
        ${node.allowedTools ?? []}, ${node.requiredEvidence ?? []},
        ${node.confidenceThreshold ?? null}, ${node.timeoutSeconds ?? 900},
        ${node.maxAttempts ?? 3}, ${node.retryBackoffSeconds ?? 30},
        ${node.riskLevel ?? "low"}, ${node.requiresApproval ?? false},
        ${node.approvalRole ?? null}, ${node.idempotencyStrategy ?? "fan_key"},
        ${node.failureStrategy ?? "fail_workflow"}, ${node.autonomyLevel ?? null},
        ${tx.json((node.config ?? {}) as never)}
      )
    `;
  }
  for (const edge of args.def.edges) {
    await tx`
      insert into workflow_edges (
        version_id, from_node_key, to_node_key, condition, priority, required,
        on_failure, loop_max_iterations
      ) values (
        ${versionId}, ${edge.from}, ${edge.to},
        ${edge.condition ? tx.json(edge.condition as never) : null},
        ${edge.priority ?? 100}, ${edge.required !== false},
        ${edge.onFailure ?? "block"}, ${edge.loop?.maxIterations ?? null}
      )
    `;
  }
  return { versionId, version };
}

export async function latestVersionForKey(
  key: string
): Promise<{ versionId: string; version: number; spec: WorkflowDefinition } | null> {
  const [row] = await sql`
    select v.id, v.version, v.spec
    from workflow_versions v
    join workflow_definitions d on d.id = v.definition_id
    where d.key = ${key} and d.active and v.status = 'published'
    order by v.version desc limit 1
  `;
  return row
    ? {
        versionId: row.id as string,
        version: row.version as number,
        spec: row.spec as WorkflowDefinition,
      }
    : null;
}

export async function versionSpec(
  versionId: string
): Promise<{ spec: WorkflowDefinition; version: number } | null> {
  const [row] = await sql`
    select spec, version from workflow_versions where id = ${versionId}
  `;
  return row ? { spec: row.spec as WorkflowDefinition, version: row.version as number } : null;
}

export async function nodeIdsForVersion(
  tx: Tx,
  versionId: string
): Promise<Map<string, string>> {
  const rows = await tx`
    select id, node_key from workflow_nodes where version_id = ${versionId}
  `;
  return new Map(rows.map((r) => [r.nodeKey as string, r.id as string]));
}

export async function edgesForVersion(
  versionId: string
): Promise<{ from: string; to: string; condition: EdgeCondition | null; required: boolean }[]> {
  const rows = await sql`
    select from_node_key, to_node_key, condition, required
    from workflow_edges where version_id = ${versionId}
  `;
  return rows.map((r) => ({
    from: r.fromNodeKey as string,
    to: r.toNodeKey as string,
    condition: (r.condition as EdgeCondition | null) ?? null,
    required: r.required as boolean,
  }));
}

// ---------------------------------------------------------------- runs

function toRun(row: Record<string, unknown>): WorkflowRun {
  return {
    id: row.id as string,
    versionId: row.versionId as string,
    definitionKey: (row.definitionKey as string) ?? "",
    workflowVersion: Number(row.workflowVersion ?? row.version ?? 0),
    projectId: (row.projectId as string | null) ?? null,
    state: row.state as WorkflowState,
    input: (row.input as Record<string, unknown>) ?? {},
    output: (row.output as Record<string, unknown> | null) ?? null,
    stopReason: (row.stopReason as string | null) ?? null,
    costMicroUsd: Number(row.costMicroUsd ?? 0),
    costCapMicroUsd:
      row.costCapMicroUsd === null || row.costCapMicroUsd === undefined
        ? null
        : Number(row.costCapMicroUsd),
    maxParallel: Number(row.maxParallel ?? 8),
    startedAt: row.startedAt as Date,
    finishedAt: (row.finishedAt as Date | null) ?? null,
  };
}

const RUN_SELECT = sql`
  select r.*, d.key as definition_key, v.version as workflow_version
  from workflow_runs r
  join workflow_versions v on v.id = r.version_id
  join workflow_definitions d on d.id = v.definition_id
`;

export async function insertRun(
  tx: Tx,
  args: {
    versionId: string;
    projectId: string | null;
    trigger: string;
    idempotencyKey: string;
    input: Record<string, unknown>;
    costCapMicroUsd: number | null;
    maxParallel: number;
    startedBy: string | null;
  }
): Promise<{ id: string; created: boolean }> {
  const [row] = await tx`
    insert into workflow_runs (
      version_id, project_id, trigger, idempotency_key, input,
      cost_cap_micro_usd, max_parallel, started_by
    ) values (
      ${args.versionId}, ${args.projectId}, ${args.trigger}, ${args.idempotencyKey},
      ${tx.json(args.input as never)}, ${args.costCapMicroUsd}, ${args.maxParallel},
      ${args.startedBy}
    )
    on conflict (idempotency_key) do nothing
    returning id
  `;
  if (row) return { id: row.id as string, created: true };
  const [existing] = await tx`
    select id from workflow_runs where idempotency_key = ${args.idempotencyKey}
  `;
  return { id: existing!.id as string, created: false };
}

export async function getRun(runId: string): Promise<WorkflowRun | null> {
  const rows = await sql`${RUN_SELECT} where r.id = ${runId}`;
  return rows[0] ? toRun(rows[0]) : null;
}

/** Lock the run row for the duration of a tick — one tick per run at a time. */
export async function lockRun(tx: TransactionSql, runId: string): Promise<WorkflowRun | null> {
  const [row] = await tx`
    select r.*, d.key as definition_key, v.version as workflow_version
    from workflow_runs r
    join workflow_versions v on v.id = r.version_id
    join workflow_definitions d on d.id = v.definition_id
    where r.id = ${runId}
    for update of r
  `;
  return row ? toRun(row) : null;
}

export async function setRunState(
  tx: Tx,
  args: {
    runId: string;
    from: WorkflowState;
    to: WorkflowState;
    actor: string;
    actorUserId?: string | null;
    reason?: string;
    workflowVersion: number;
    output?: Record<string, unknown> | null;
    stopReason?: string | null;
  }
): Promise<void> {
  const terminal = [
    "completed",
    "failed",
    "cancelled",
    "safely_stopped",
    "timed_out",
    "partially_completed",
  ].includes(args.to);
  await tx`
    update workflow_runs set
      state = ${args.to},
      output = ${args.output === undefined ? sql`output` : tx.json((args.output ?? null) as never)},
      stop_reason = ${args.stopReason === undefined ? sql`stop_reason` : args.stopReason},
      updated_at = now(),
      finished_at = ${terminal ? sql`now()` : sql`finished_at`}
    where id = ${args.runId}
  `;
  await tx`
    insert into workflow_transitions (
      workflow_run_id, scope, from_state, to_state, actor, actor_user_id,
      reason, workflow_version
    ) values (
      ${args.runId}, 'workflow', ${args.from}, ${args.to}, ${args.actor},
      ${args.actorUserId ?? null}, ${args.reason ?? ""}, ${args.workflowVersion}
    )
  `;
}

export async function addRunCost(tx: Tx, runId: string, micro: number): Promise<void> {
  if (micro <= 0) return;
  await tx`update workflow_runs set cost_micro_usd = cost_micro_usd + ${micro} where id = ${runId}`;
}

// ------------------------------------------------------------- node runs

function toNodeRun(row: Record<string, unknown>): NodeRun {
  return {
    id: row.id as string,
    workflowRunId: row.workflowRunId as string,
    nodeId: row.nodeId as string,
    nodeKey: row.nodeKey as string,
    fanKey: row.fanKey as string,
    state: row.state as NodeState,
    attempts: Number(row.attempts ?? 0),
    input: (row.input as Record<string, unknown> | null) ?? null,
    output: (row.output as Record<string, unknown> | null) ?? null,
    confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
    costMicroUsd: Number(row.costMicroUsd ?? 0),
    error: (row.error as string | null) ?? null,
    humanTouch: Boolean(row.humanTouch),
    nextAttemptAt: (row.nextAttemptAt as Date | null) ?? null,
    startedAt: (row.startedAt as Date | null) ?? null,
    finishedAt: (row.finishedAt as Date | null) ?? null,
  };
}

export async function listNodeRuns(runId: string): Promise<NodeRun[]> {
  const rows = await sql`
    select * from node_runs where workflow_run_id = ${runId}
    order by created_at asc
  `;
  return rows.map(toNodeRun);
}

export async function getNodeRun(nodeRunId: string): Promise<NodeRun | null> {
  const [row] = await sql`select * from node_runs where id = ${nodeRunId}`;
  return row ? toNodeRun(row) : null;
}

/**
 * Claim a node instance for execution. The unique (run, node, fan_key) index
 * makes this the idempotency point: a concurrent tick or a retry that races
 * gets `null` and does nothing, so completed work is never duplicated.
 */
export async function claimNodeInstance(
  tx: TransactionSql,
  args: {
    runId: string;
    nodeId: string;
    nodeKey: string;
    fanKey: string;
    input: Record<string, unknown>;
    workflowVersion: number;
  }
): Promise<NodeRun | null> {
  const [row] = await tx`
    insert into node_runs (
      workflow_run_id, node_id, node_key, fan_key, state, attempts, input,
      ready_at, started_at
    ) values (
      ${args.runId}, ${args.nodeId}, ${args.nodeKey}, ${args.fanKey}, 'running', 1,
      ${tx.json(args.input as never)}, now(), now()
    )
    on conflict (workflow_run_id, node_key, fan_key) do update set
      state = 'running',
      attempts = node_runs.attempts + 1,
      input = ${tx.json(args.input as never)},
      started_at = now()
    where node_runs.state in ('pending', 'ready', 'failed_retryable')
      and (node_runs.next_attempt_at is null or node_runs.next_attempt_at <= now())
    returning *
  `;
  if (!row) return null;
  const claimed = toNodeRun(row);
  await tx`
    insert into workflow_transitions (
      workflow_run_id, node_run_id, scope, from_state, to_state, actor, reason,
      workflow_version, node_version
    ) values (
      ${args.runId}, ${claimed.id}, 'node', 'ready', 'running', 'engine',
      ${`attempt ${claimed.attempts}`}, ${args.workflowVersion}, ${args.nodeKey}
    )
  `;
  return claimed;
}

/**
 * Reclaim node instances stranded in `running` by a dead worker.
 *
 * A live handler is bounded by the engine's withTimeout(timeout_seconds), so
 * an instance still `running` past timeout + grace can only belong to a
 * process that died mid-node. Under max_attempts it returns to
 * `failed_retryable` and the normal retry machinery re-runs it; at the cap it
 * settles `failed_terminal` so the run discloses the failure — the one thing
 * this function must never allow is that stranded work reads as completed.
 */
export const STALE_NODE_GRACE_SECONDS = 60;

export async function reclaimStaleNodeInstances(
  runId: string,
  workflowVersion: number
): Promise<{ retried: string[]; terminal: string[] }> {
  return sql.begin(async (tx) => {
    const stale = await tx`
      select nr.id, nr.node_key, nr.attempts, wn.max_attempts
      from node_runs nr
      join workflow_nodes wn on wn.id = nr.node_id
      where nr.workflow_run_id = ${runId}
        and nr.state = 'running'
        and nr.started_at < now() -
          make_interval(secs => wn.timeout_seconds + ${STALE_NODE_GRACE_SECONDS})
      for update of nr skip locked
    `;
    const retried: string[] = [];
    const terminal: string[] = [];
    for (const row of stale) {
      const exhausted = Number(row.attempts) >= Number(row.maxAttempts);
      const to: NodeState = exhausted ? "failed_terminal" : "failed_retryable";
      await tx`
        update node_runs set
          state = ${to},
          error = ${`stale running instance reclaimed: the worker died mid-node on attempt ${row.attempts}`},
          next_attempt_at = ${exhausted ? sql`next_attempt_at` : sql`now()`},
          finished_at = ${exhausted ? sql`now()` : sql`finished_at`}
        where id = ${row.id}
      `;
      await tx`
        insert into workflow_transitions (
          workflow_run_id, node_run_id, scope, from_state, to_state, actor,
          reason, workflow_version, node_version
        ) values (
          ${runId}, ${row.id}, 'node', 'running', ${to}, 'engine',
          'stale running instance reclaimed after worker death',
          ${workflowVersion}, ${row.nodeKey}
        )
      `;
      (exhausted ? terminal : retried).push(String(row.nodeKey));
    }
    return { retried, terminal };
  });
}

export async function settleNodeInstance(
  tx: Tx,
  args: {
    nodeRunId: string;
    runId: string;
    nodeKey: string;
    from: NodeState;
    to: NodeState;
    output?: Record<string, unknown> | null;
    confidence?: number | null;
    costMicroUsd?: number;
    error?: string | null;
    actor?: string;
    actorUserId?: string | null;
    reason?: string;
    humanTouch?: boolean;
    retryInSeconds?: number | null;
    workflowVersion: number;
  }
): Promise<void> {
  const finished = ["succeeded", "failed_terminal", "skipped", "cancelled", "timed_out"].includes(
    args.to
  );
  await tx`
    update node_runs set
      state = ${args.to},
      output = ${args.output === undefined ? sql`output` : tx.json((args.output ?? null) as never)},
      confidence = ${args.confidence === undefined ? sql`confidence` : (args.confidence ?? null)},
      cost_micro_usd = cost_micro_usd + ${args.costMicroUsd ?? 0},
      error = ${args.error === undefined ? sql`error` : args.error},
      human_touch = ${args.humanTouch ? true : sql`human_touch`},
      next_attempt_at = ${
        args.retryInSeconds
          ? sql`now() + make_interval(secs => ${args.retryInSeconds})`
          : sql`next_attempt_at`
      },
      finished_at = ${finished ? sql`now()` : sql`finished_at`}
    where id = ${args.nodeRunId}
  `;
  await tx`
    insert into workflow_transitions (
      workflow_run_id, node_run_id, scope, from_state, to_state, actor,
      actor_user_id, reason, workflow_version, node_version
    ) values (
      ${args.runId}, ${args.nodeRunId}, 'node', ${args.from}, ${args.to},
      ${args.actor ?? "engine"}, ${args.actorUserId ?? null}, ${args.reason ?? ""},
      ${args.workflowVersion}, ${args.nodeKey}
    )
  `;
}

/** Fan keys a fan-out node produced, so downstream nodes know their instances. */
export async function fanKeysFromOutputs(runId: string): Promise<Map<string, string[]>> {
  const rows = await sql`
    select node_key, output from node_runs
    where workflow_run_id = ${runId} and state = 'succeeded'
      and output ? 'fanKeys'
  `;
  const map = new Map<string, string[]>();
  for (const row of rows) {
    const keys = (row.output as { fanKeys?: unknown }).fanKeys;
    if (Array.isArray(keys)) map.set(row.nodeKey as string, keys.map(String));
  }
  return map;
}

// ------------------------------------------------------------- signals

export async function insertSignal(
  tx: Tx,
  args: {
    runId: string;
    nodeRunId: string | null;
    kind: string;
    payload: Record<string, unknown>;
    sentBy: string | null;
  }
): Promise<string> {
  const [row] = await tx`
    insert into workflow_signals (workflow_run_id, node_run_id, kind, payload, sent_by)
    values (${args.runId}, ${args.nodeRunId}, ${args.kind},
      ${tx.json(args.payload as never)}, ${args.sentBy})
    returning id
  `;
  return row!.id as string;
}

export async function consumeSignals(
  tx: TransactionSql,
  runId: string
): Promise<{ id: string; nodeRunId: string | null; kind: string; payload: Record<string, unknown>; sentBy: string | null }[]> {
  const rows = await tx`
    update workflow_signals set consumed_at = now()
    where workflow_run_id = ${runId} and consumed_at is null
    returning id, node_run_id, kind, payload, sent_by
  `;
  return rows.map((r) => ({
    id: r.id as string,
    nodeRunId: (r.nodeRunId as string | null) ?? null,
    kind: r.kind as string,
    payload: (r.payload as Record<string, unknown>) ?? {},
    sentBy: (r.sentBy as string | null) ?? null,
  }));
}

// ------------------------------------------------------------ approvals

export interface PendingApprovalRow {
  id: string;
  summary: string;
  riskLevel: string;
  requiredRole: string;
  actionType: string;
  requestedAt: Date;
  dueAt: Date | null;
  runId: string;
  definitionKey: string;
  projectName: string | null;
}

/** Every undecided approval across every run — the /approvals inbox (C2).
 * Ordered by urgency: overdue first, then nearest deadline. */
export async function pendingApprovalsAcrossRuns(): Promise<PendingApprovalRow[]> {
  return sql<PendingApprovalRow[]>`
    select a.id, a.summary, a.risk_level, a.required_role, a.action_type,
      a.requested_at, a.due_at,
      r.id as run_id, d.key as definition_key, p.name as project_name
    from workflow_approvals a
    join workflow_runs r on r.id = a.workflow_run_id
    join workflow_versions v on v.id = r.version_id
    join workflow_definitions d on d.id = v.definition_id
    left join projects p on p.id = a.project_id
    where a.decision is null
    order by a.due_at asc nulls last, a.requested_at asc
  `;
}

export interface DecidedApprovalRow {
  id: string;
  summary: string;
  decision: string;
  rationale: string | null;
  decidedAt: Date;
  decidedByName: string | null;
  runId: string;
  definitionKey: string;
  projectName: string | null;
}

/** Recent decisions, newest first — the inbox's evidence trail. */
export async function recentApprovalDecisions(limit: number): Promise<DecidedApprovalRow[]> {
  return sql<DecidedApprovalRow[]>`
    select a.id, a.summary, a.decision, a.rationale, a.decided_at,
      u.name as decided_by_name,
      r.id as run_id, d.key as definition_key, p.name as project_name
    from workflow_approvals a
    join workflow_runs r on r.id = a.workflow_run_id
    join workflow_versions v on v.id = r.version_id
    join workflow_definitions d on d.id = v.definition_id
    left join projects p on p.id = a.project_id
    left join users u on u.id = a.decided_by
    where a.decision is not null
    order by a.decided_at desc
    limit ${limit}
  `;
}

export async function insertApproval(
  tx: Tx,
  args: {
    runId: string;
    nodeRunId: string;
    projectId: string | null;
    actionType: string;
    riskLevel: string;
    requiredRole: string;
    summary: string;
    detail: Record<string, unknown>;
    evidenceIds: string[];
    dueAt: Date | null;
  }
): Promise<string> {
  const [row] = await tx`
    insert into workflow_approvals (
      workflow_run_id, node_run_id, project_id, action_type, risk_level,
      required_role, summary, detail, evidence_ids, due_at
    ) values (
      ${args.runId}, ${args.nodeRunId}, ${args.projectId}, ${args.actionType},
      ${args.riskLevel}, ${args.requiredRole}, ${args.summary},
      ${tx.json(args.detail as never)}, ${args.evidenceIds}, ${args.dueAt}
    )
    on conflict (node_run_id) do nothing
    returning id
  `;
  if (row) return row.id as string;
  const [existing] = await tx`
    select id from workflow_approvals where node_run_id = ${args.nodeRunId}
  `;
  return existing!.id as string;
}

export async function decideApproval(
  tx: Tx,
  args: {
    approvalId: string;
    decision: "approved" | "rejected" | "deferred";
    decidedBy: string;
    rationale: string;
  }
): Promise<{ runId: string; nodeRunId: string } | null> {
  const [row] = await tx`
    update workflow_approvals set
      decision = ${args.decision}, decided_by = ${args.decidedBy},
      decided_at = now(), rationale = ${args.rationale}
    where id = ${args.approvalId} and decision is null
    returning workflow_run_id, node_run_id
  `;
  return row
    ? { runId: row.workflowRunId as string, nodeRunId: row.nodeRunId as string }
    : null;
}

export async function pendingApproval(
  nodeRunId: string
): Promise<{ id: string; decision: string | null; decidedBy: string | null } | null> {
  const [row] = await sql`
    select id, decision, decided_by from workflow_approvals where node_run_id = ${nodeRunId}
  `;
  return row
    ? {
        id: row.id as string,
        decision: (row.decision as string | null) ?? null,
        decidedBy: (row.decidedBy as string | null) ?? null,
      }
    : null;
}

// ------------------------------------------------------- gates & helpers

export async function recordGateResult(
  tx: Tx,
  args: {
    runId: string;
    nodeRunId: string | null;
    gateType: string;
    gateVersion: string;
    outcome: "pass" | "fail" | "insufficient_evidence";
    checks: unknown;
  }
): Promise<void> {
  await tx`
    insert into quality_gate_results (
      workflow_run_id, node_run_id, gate_type, gate_version, outcome, checks
    ) values (
      ${args.runId}, ${args.nodeRunId}, ${args.gateType}, ${args.gateVersion},
      ${args.outcome}, ${tx.json(args.checks as never)}
    )
  `;
}

export async function nodeDefinitionsFor(
  versionId: string
): Promise<Map<string, NodeDefinition & { id: string }>> {
  const rows = await sql`select * from workflow_nodes where version_id = ${versionId}`;
  const map = new Map<string, NodeDefinition & { id: string }>();
  for (const row of rows) {
    map.set(row.nodeKey as string, {
      id: row.id as string,
      key: row.nodeKey as string,
      type: row.nodeType as NodeDefinition["type"],
      name: row.name as string,
      description: (row.description as string) ?? "",
      handler: (row.handler as string | null) ?? undefined,
      agentVersion: (row.agentVersion as string | null) ?? undefined,
      allowedTools: (row.allowedTools as string[]) ?? [],
      requiredEvidence: (row.requiredEvidence as string[]) ?? [],
      confidenceThreshold:
        row.confidenceThreshold === null ? undefined : Number(row.confidenceThreshold),
      timeoutSeconds: Number(row.timeoutSeconds),
      maxAttempts: Number(row.maxAttempts),
      retryBackoffSeconds: Number(row.retryBackoffSeconds),
      riskLevel: row.riskLevel as NodeDefinition["riskLevel"],
      requiresApproval: Boolean(row.requiresApproval),
      approvalRole: (row.approvalRole as NodeDefinition["approvalRole"]) ?? undefined,
      idempotencyStrategy: row.idempotencyStrategy as NodeDefinition["idempotencyStrategy"],
      failureStrategy: row.failureStrategy as NodeDefinition["failureStrategy"],
      autonomyLevel:
        row.autonomyLevel === null ? undefined : (Number(row.autonomyLevel) as 0 | 1 | 2 | 3 | 4),
      config: (row.config as Record<string, unknown>) ?? {},
    });
  }
  return map;
}
