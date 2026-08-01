/**
 * The workflow engine (spec 018).
 *
 * Shape: a **tick**. `advanceWorkflow(runId)` claims the run, asks the pure
 * graph module which node instances are ready, executes a bounded number of
 * them, records every transition, and re-enqueues itself while work remains.
 * That is the whole control flow — the same proven pattern as
 * `lib/cycles/service.ts`, generalised from one hard-coded process to any
 * declared graph.
 *
 * Two invariants hold everywhere below:
 *  1. A node handler never writes workflow state. It returns a NodeResult and
 *     the engine performs the write, inside the transaction that also records
 *     the transition.
 *  2. The engine never invents semantics. Whether a node is ready, whether a
 *     condition holds, whether a cycle is legal — all of that is
 *     lib/workflow/graph.ts, which has no I/O and is unit-tested.
 */
import { createHash } from "node:crypto";
import { sql, type TransactionSql } from "@/db/client";
import { enqueueJob } from "@/db/jobs";
import { writeAudit } from "@/db/audit";
import { ClassifiedError } from "@/lib/errors";
import { log } from "@/lib/logger";
import * as store from "@/db/workflow";
import {
  computeReady,
  validateGraph,
  MAX_FAN_OUT,
  type InstanceState,
} from "@/lib/workflow/graph";
import {
  resolveAutonomy,
  requiresApprovalFor,
  isManualOnly,
  isEffectful,
} from "@/lib/workflow/autonomy";
import { raiseException } from "@/lib/workflow/exceptions";
import { knownAgentVersions } from "@/lib/workflow/agent-versions";
import { getHandler } from "@/lib/workflow/handlers";
import type {
  NodeContext,
  NodeDefinition,
  NodeResult,
  NodeState,
  StartWorkflowInput,
  WorkflowDefinition,
  WorkflowEngine,
  WorkflowRun,
  WorkflowSignal,
  WorkflowState,
} from "@/lib/workflow/types";
import { SETTLED_NODE_STATES } from "@/lib/workflow/types";

/** Seconds between ticks when a run is waiting on something external. */
const EXTERNAL_WAIT_SECONDS = 60;
/** How long an approval may sit before the run safe-stops (Part 31). */
export const APPROVAL_TIMEOUT_HOURS = 72;

// ------------------------------------------------------------- registration

/** Canonical graph hash: identical graphs never create a second version. */
export function graphHash(def: WorkflowDefinition): string {
  const canonical = JSON.stringify({
    key: def.key,
    actionType: def.actionType,
    autonomyLevel: def.autonomyLevel,
    nodes: [...def.nodes]
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((n) => ({ ...n, config: n.config ?? {} })),
    edges: [...def.edges].sort((a, b) =>
      `${a.from}->${a.to}`.localeCompare(`${b.from}->${b.to}`)
    ),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export async function registerDefinition(
  def: WorkflowDefinition,
  createdBy: string | null = null
): Promise<{ versionId: string; created: boolean; version: number }> {
  const errors = validateGraph(def, { knownAgentVersions: knownAgentVersions() });
  if (errors.length > 0) {
    throw new ClassifiedError(
      "validation",
      `Workflow "${def.key}" is not a valid graph: ${errors.map((e) => e.message).join(" ")}`
    );
  }
  const hash = graphHash(def);
  return sql.begin(async (tx) => {
    const definitionId = await store.upsertDefinition(tx, def);
    const existing = await store.findVersionByHash(tx, definitionId, hash);
    if (existing) {
      return { versionId: existing.versionId, created: false, version: existing.version };
    }
    const inserted = await store.insertVersion(tx, {
      definitionId,
      graphHash: hash,
      def,
      createdBy,
    });
    log("info", "workflow.version.published", {
      key: def.key,
      version: inserted.version,
      nodes: def.nodes.length,
      edges: def.edges.length,
    });
    return { ...inserted, created: true };
  });
}

// ----------------------------------------------------------------- start

export async function startWorkflow(input: StartWorkflowInput): Promise<WorkflowRun> {
  const latest = await store.latestVersionForKey(input.definitionKey);
  if (!latest) {
    throw new ClassifiedError(
      "not_found",
      `No published version of workflow "${input.definitionKey}". Register it first.`
    );
  }
  const { runId, created } = await sql.begin(async (tx) => {
    const result = await store.insertRun(tx, {
      versionId: latest.versionId,
      projectId: input.projectId ?? null,
      trigger: input.trigger ?? "manual",
      idempotencyKey: input.idempotencyKey,
      input: input.input ?? {},
      costCapMicroUsd: input.costCapMicroUsd ?? null,
      maxParallel: input.maxParallel ?? 8,
      startedBy: input.startedBy ?? null,
    });
    if (result.created) {
      await store.setRunState(tx, {
        runId: result.id,
        from: "queued",
        to: "initializing",
        actor: "engine",
        actorUserId: input.startedBy ?? null,
        reason: `started via ${input.trigger ?? "manual"}`,
        workflowVersion: latest.version,
      });
      await writeAudit(tx, {
        userId: input.startedBy ?? null,
        action: "workflow.start",
        entity: "workflow_run",
        entityId: result.id,
        detail: { definitionKey: input.definitionKey, version: latest.version },
      });
      await enqueueJob(tx, "advance_workflow", { runId: result.id });
    }
    return { runId: result.id, created: result.created };
  });

  const run = await store.getRun(runId);
  if (!run) throw new ClassifiedError("internal", "Workflow run vanished after insert.");
  if (!created) {
    // Idempotent start: the caller gets the original run, and we say so.
    log("info", "workflow.start.deduplicated", { runId, key: input.definitionKey });
  }
  return run;
}

// ------------------------------------------------------------ the tick

interface TickOutcome {
  state: WorkflowState;
  executed: number;
}

/**
 * Advance one workflow by one tick. Safe to call repeatedly, safe after a
 * crash: every decision is recomputed from durable state.
 */
export async function advanceWorkflow(runId: string): Promise<WorkflowState> {
  const outcome = await tick(runId);
  return outcome.state;
}

async function tick(runId: string): Promise<TickOutcome> {
  const run = await store.getRun(runId);
  if (!run) throw new ClassifiedError("not_found", `Workflow run ${runId} not found.`);
  if (isTerminal(run.state)) return { state: run.state, executed: 0 };

  const versionInfo = await store.versionSpec(run.versionId);
  if (!versionInfo) throw new ClassifiedError("internal", "Workflow version missing.");
  const def = versionInfo.spec;
  const workflowVersion = versionInfo.version;
  const nodeDefs = await store.nodeDefinitionsFor(run.versionId);

  // Signals first: an approval decision that arrived since the last tick may
  // be exactly what unblocks this run — or, on a rejection, what ends it.
  await applySignals(run, workflowVersion, nodeDefs);
  const afterSignals = await store.getRun(runId);
  if (afterSignals && isTerminal(afterSignals.state)) {
    return { state: afterSignals.state, executed: 0 };
  }

  if (run.state === "initializing" || run.state === "queued") {
    await sql.begin((tx) =>
      store.setRunState(tx, {
        runId,
        from: run.state,
        to: "running",
        actor: "engine",
        reason: "entering execution",
        workflowVersion,
      })
    );
  }

  // Heal crashed workers before planning: a node stranded in `running` by a
  // dead process would otherwise be neither ready nor settled, and the run
  // could settle around it. Stale instances go back to failed_retryable (or
  // failed_terminal at the attempt cap) with next_attempt_at = now, so the
  // ready-set below re-offers them in this very tick.
  const stale = await store.reclaimStaleNodeInstances(run.id, workflowVersion);
  if (stale.retried.length > 0 || stale.terminal.length > 0) {
    log("warn", "workflow.stale_nodes_reclaimed", {
      runId,
      retried: stale.retried,
      terminal: stale.terminal,
    });
  }

  const instances = await store.listNodeRuns(runId);
  const fanKeys = await store.fanKeysFromOutputs(runId);
  const fanKeysByNode = propagateFanKeys(def, fanKeys);

  const now = Date.now();
  const ready = computeReady(
    def,
    instances.map<InstanceState>((i) => ({
      nodeKey: i.nodeKey,
      fanKey: i.fanKey,
      state: i.state,
      output: i.output,
      retryEligible: i.nextAttemptAt === null || i.nextAttemptAt.getTime() <= now,
    })),
    fanKeysByNode
  );

  // A node awaiting approval or a retry backoff is neither ready nor settled;
  // the run is alive but parked.
  const parked = instances.filter(
    (i) => i.state === "awaiting_approval" || i.state === "awaiting_verification"
  );
  const retrying = instances.filter((i) => i.state === "failed_retryable");

  if (ready.length === 0) {
    return settleRun(run, def, workflowVersion, instances, parked.length, retrying.length);
  }

  let executed = 0;
  const limit = Math.max(1, run.maxParallel);
  for (const candidate of ready) {
    if (executed >= limit) break;
    const nodeDef = nodeDefs.get(candidate.nodeKey);
    if (!nodeDef) continue;

    // Cost cap is checked BEFORE execution — stopping after spending is not a
    // cap, it is a receipt.
    const current = await store.getRun(runId);
    if (
      current?.costCapMicroUsd !== null &&
      current !== null &&
      current.costMicroUsd >= (current.costCapMicroUsd ?? Infinity)
    ) {
      await stopSafely(
        run,
        workflowVersion,
        `cost cap reached (${current.costMicroUsd} of ${current.costCapMicroUsd} micro-USD)`,
        "cost_anomaly"
      );
      return { state: "safely_stopped", executed };
    }

    const didRun = await executeNode({
      run,
      def,
      workflowVersion,
      nodeDef,
      nodeKey: candidate.nodeKey,
      fanKey: candidate.fanKey,
      inputs: candidate.inputs,
    });
    if (didRun) executed += 1;
  }

  // More work almost certainly remains — come straight back.
  await sql.begin((tx) => enqueueJob(tx, "advance_workflow", { runId }));
  return { state: "running", executed };
}

function isTerminal(state: WorkflowState): boolean {
  return [
    "completed",
    "failed",
    "cancelled",
    "safely_stopped",
    "timed_out",
    "partially_completed",
  ].includes(state);
}

/**
 * Fan keys flow downstream: every node reachable from a fan-out runs once per
 * key, until a fan_in collapses back to the singleton key.
 */
export function propagateFanKeys(
  def: WorkflowDefinition,
  producedKeys: Map<string, string[]>
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const edge of def.edges) {
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
  }
  const typeOf = new Map(def.nodes.map((n) => [n.key, n.type]));

  for (const [fanNode, keys] of producedKeys) {
    const bounded = keys.slice(0, MAX_FAN_OUT);
    const queue = [...(outgoing.get(fanNode) ?? [])];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const key = queue.shift()!;
      if (seen.has(key)) continue;
      seen.add(key);
      if (typeOf.get(key) === "fan_in") continue; // collapses here
      result.set(key, bounded);
      for (const next of outgoing.get(key) ?? []) queue.push(next);
    }
  }
  return result;
}

// -------------------------------------------------------- node execution

interface ExecuteArgs {
  run: WorkflowRun;
  def: WorkflowDefinition;
  workflowVersion: number;
  nodeDef: NodeDefinition & { id: string };
  nodeKey: string;
  fanKey: string;
  inputs: Record<string, unknown>;
}

/** Returns false when another tick already claimed this instance. */
async function executeNode(args: ExecuteArgs): Promise<boolean> {
  const { run, nodeDef, nodeKey, fanKey, workflowVersion } = args;

  const claimed = await sql.begin((tx: TransactionSql) =>
    store.claimNodeInstance(tx, {
      runId: run.id,
      nodeId: nodeDef.id,
      nodeKey,
      fanKey,
      input: args.inputs,
      workflowVersion,
    })
  );
  if (!claimed) return false;

  // Autonomy is resolved per execution, not per template — a per-client policy
  // can make the same node approval-gated for one client and not another.
  const autonomy = await resolveAutonomy({
    projectId: run.projectId,
    workflowKey: run.definitionKey,
    actionType: (nodeDef.config?.actionType as string) ?? args.def.actionType,
    riskLevel: nodeDef.riskLevel ?? "low",
    workflowLevel: args.def.autonomyLevel,
    nodeLevel: nodeDef.autonomyLevel,
  });

  if (isManualOnly(autonomy.level)) {
    await sql.begin(async (tx) => {
      await store.settleNodeInstance(tx, {
        nodeRunId: claimed.id,
        runId: run.id,
        nodeKey,
        from: "running",
        to: "skipped",
        output: { skipped: "manual_only", autonomy },
        reason: `autonomy level 0 — ${autonomy.detail}`,
        workflowVersion,
      });
      await raiseException(tx, {
        projectId: run.projectId,
        workflowRunId: run.id,
        nodeRunId: claimed.id,
        kind: "missing_client_input",
        severity: nodeDef.riskLevel ?? "medium",
        summary: `${nodeDef.name} is manual-only (autonomy 0) and must be performed by a human.`,
        recommendedAction: "Perform the action outside the platform and record the result.",
      });
    });
    return true;
  }

  let result: NodeResult;
  try {
    const handler = getHandler(nodeDef.handler ?? nodeDef.type);
    const ctx: NodeContext = {
      runId: run.id,
      projectId: run.projectId,
      nodeKey,
      fanKey,
      attempt: claimed.attempts,
      inputs: args.inputs,
      workflowInput: run.input,
      config: nodeDef.config ?? {},
      node: nodeDef,
      remainingCostMicroUsd:
        run.costCapMicroUsd === null ? null : run.costCapMicroUsd - run.costMicroUsd,
    };
    result = await withTimeout(handler(ctx), (nodeDef.timeoutSeconds ?? 900) * 1000, nodeKey);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result = { outcome: "failed_retryable", error: message };
  }

  // An approval-gated node cannot succeed on the engine's say-so. Autonomy
  // gates the nodes that ACT; gates and verifications guard those nodes and are
  // not themselves the consequential act (see isEffectful).
  if (
    result.outcome === "succeeded" &&
    (nodeDef.requiresApproval ||
      (requiresApprovalFor(autonomy.level) && isEffectful(nodeDef.type))) &&
    nodeDef.type !== "approval_gate"
  ) {
    result = {
      ...result,
      outcome: "awaiting_approval",
      reason:
        result.reason ??
        `autonomy level ${autonomy.level} requires approval before this counts as done (${autonomy.detail})`,
    };
  }

  await recordNodeResult({ ...args, claimedId: claimed.id, attempts: claimed.attempts, result, autonomyDetail: autonomy.detail });
  return true;
}

async function recordNodeResult(
  args: ExecuteArgs & {
    claimedId: string;
    attempts: number;
    result: NodeResult;
    autonomyDetail: string;
  }
): Promise<void> {
  const { run, nodeDef, nodeKey, workflowVersion, result, claimedId, attempts } = args;
  const maxAttempts = nodeDef.maxAttempts ?? 3;

  await sql.begin(async (tx) => {
    await store.addRunCost(tx, run.id, result.costMicroUsd ?? 0);

    if (result.outcome === "succeeded") {
      await store.settleNodeInstance(tx, {
        nodeRunId: claimedId,
        runId: run.id,
        nodeKey,
        from: "running",
        to: "succeeded",
        output: { ...(result.output ?? {}), ...(result.fanKeys ? { fanKeys: result.fanKeys } : {}) },
        confidence: result.confidence ?? null,
        costMicroUsd: result.costMicroUsd ?? 0,
        error: null,
        reason: result.reason ?? "",
        workflowVersion,
      });
      return;
    }

    if (result.outcome === "awaiting_approval") {
      await store.settleNodeInstance(tx, {
        nodeRunId: claimedId,
        runId: run.id,
        nodeKey,
        from: "running",
        to: "awaiting_approval",
        output: result.output ?? null,
        confidence: result.confidence ?? null,
        costMicroUsd: result.costMicroUsd ?? 0,
        reason: result.reason ?? "approval required",
        workflowVersion,
      });
      await store.insertApproval(tx, {
        runId: run.id,
        nodeRunId: claimedId,
        projectId: run.projectId,
        actionType: (nodeDef.config?.actionType as string) ?? args.def.actionType,
        riskLevel: nodeDef.riskLevel ?? "low",
        requiredRole: nodeDef.approvalRole ?? "operator",
        summary: result.reason ?? `${nodeDef.name} needs approval`,
        detail: { output: result.output ?? {}, autonomy: args.autonomyDetail },
        evidenceIds: result.evidenceIds ?? [],
        dueAt: new Date(Date.now() + APPROVAL_TIMEOUT_HOURS * 3600_000),
      });
      await raiseException(tx, {
        projectId: run.projectId,
        workflowRunId: run.id,
        nodeRunId: claimedId,
        kind: "client_approval",
        severity: nodeDef.riskLevel ?? "medium",
        summary: result.reason ?? `${nodeDef.name} is waiting for approval`,
        recommendedAction: "Review the prepared action and approve or reject it.",
        evidenceIds: result.evidenceIds ?? [],
      });
      return;
    }

    if (result.outcome === "awaiting_verification") {
      await store.settleNodeInstance(tx, {
        nodeRunId: claimedId,
        runId: run.id,
        nodeKey,
        from: "running",
        to: "awaiting_verification",
        output: result.output ?? null,
        confidence: result.confidence ?? null,
        costMicroUsd: result.costMicroUsd ?? 0,
        reason: result.reason ?? "verification required",
        workflowVersion,
      });
      return;
    }

    if (result.outcome === "skipped") {
      await store.settleNodeInstance(tx, {
        nodeRunId: claimedId,
        runId: run.id,
        nodeKey,
        from: "running",
        to: "skipped",
        output: result.output ?? null,
        reason: result.reason ?? "condition not met",
        workflowVersion,
      });
      return;
    }

    if (result.outcome === "safe_stop") {
      await store.settleNodeInstance(tx, {
        nodeRunId: claimedId,
        runId: run.id,
        nodeKey,
        from: "running",
        to: "failed_terminal",
        output: result.output ?? null,
        error: result.reason ?? "safe stop",
        reason: result.reason ?? "safe stop",
        workflowVersion,
      });
      await store.setRunState(tx, {
        runId: run.id,
        from: run.state,
        to: "safely_stopped",
        actor: "engine",
        reason: result.reason ?? "safe stop",
        workflowVersion,
        stopReason: result.reason ?? "safe stop",
      });
      await raiseException(tx, {
        projectId: run.projectId,
        workflowRunId: run.id,
        nodeRunId: claimedId,
        kind: "safe_stop",
        severity: "high",
        summary: `${nodeDef.name} stopped safely: ${result.reason ?? "insufficient evidence"}`,
        recommendedAction: "Supply the missing evidence or decide the judgement call, then retry.",
      });
      return;
    }

    // Failure. Retryable until the node's attempt budget runs out; then the
    // node's declared failure strategy decides what happens to the workflow.
    const retryable = result.outcome === "failed_retryable" && attempts < maxAttempts;
    if (retryable) {
      await store.settleNodeInstance(tx, {
        nodeRunId: claimedId,
        runId: run.id,
        nodeKey,
        from: "running",
        to: "failed_retryable",
        error: result.error ?? "node failed",
        reason: `attempt ${attempts} of ${maxAttempts} failed`,
        retryInSeconds: (nodeDef.retryBackoffSeconds ?? 30) * 2 ** (attempts - 1),
        workflowVersion,
      });
      return;
    }

    await store.settleNodeInstance(tx, {
      nodeRunId: claimedId,
      runId: run.id,
      nodeKey,
      from: "running",
      to: "failed_terminal",
      error: result.error ?? "node failed",
      reason: `terminal after ${attempts} attempt(s)`,
      workflowVersion,
    });
    await raiseException(tx, {
      projectId: run.projectId,
      workflowRunId: run.id,
      nodeRunId: claimedId,
      kind: "failed_workflow",
      severity: nodeDef.riskLevel === "critical" ? "critical" : "high",
      summary: `${nodeDef.name} failed terminally: ${result.error ?? "unknown error"}`,
      recommendedAction: "Inspect the node error, fix the cause, then retry the node.",
    });

    const strategy = nodeDef.failureStrategy ?? "fail_workflow";
    if (strategy === "fail_workflow") {
      await store.setRunState(tx, {
        runId: run.id,
        from: run.state,
        to: "failed",
        actor: "engine",
        reason: `node ${nodeKey} failed terminally`,
        workflowVersion,
        stopReason: result.error ?? "node failed",
      });
    } else if (strategy === "safe_stop") {
      await store.setRunState(tx, {
        runId: run.id,
        from: run.state,
        to: "safely_stopped",
        actor: "engine",
        reason: `node ${nodeKey} failed; declared strategy is safe_stop`,
        workflowVersion,
        stopReason: result.error ?? "node failed",
      });
    }
    // "continue" and "escalate" leave the run alive; the exception carries it.
  });
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ClassifiedError("timeout", `Node "${label}" exceeded ${ms}ms.`)),
          ms
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ------------------------------------------------------------- settling

async function settleRun(
  run: WorkflowRun,
  def: WorkflowDefinition,
  workflowVersion: number,
  instances: Awaited<ReturnType<typeof store.listNodeRuns>>,
  parkedCount: number,
  retryingCount: number
): Promise<TickOutcome> {
  // Parked on a human: durable wait, not a poll spin.
  if (parkedCount > 0) {
    if (run.state !== "waiting_for_approval") {
      await sql.begin((tx) =>
        store.setRunState(tx, {
          runId: run.id,
          from: run.state,
          to: "waiting_for_approval",
          actor: "engine",
          reason: `${parkedCount} node(s) awaiting a human decision`,
          workflowVersion,
        })
      );
    }
    await checkApprovalTimeouts(run, workflowVersion);
    return { state: "waiting_for_approval", executed: 0 };
  }

  // Waiting on a retry backoff — come back after it elapses.
  if (retryingCount > 0) {
    if (run.state !== "waiting_for_dependency") {
      await sql.begin((tx) =>
        store.setRunState(tx, {
          runId: run.id,
          from: run.state,
          to: "waiting_for_dependency",
          actor: "engine",
          reason: `${retryingCount} node(s) in retry backoff`,
          workflowVersion,
        })
      );
    }
    await sql`
      insert into jobs (type, payload, run_after)
      values ('advance_workflow', ${sql.json({ runId: run.id } as never)},
        now() + make_interval(secs => ${EXTERNAL_WAIT_SECONDS}))
    `;
    return { state: "waiting_for_dependency", executed: 0 };
  }

  const reachedSuccess = instances.some(
    (i) =>
      i.state === "succeeded" &&
      def.nodes.find((n) => n.key === i.nodeKey)?.type === "terminal_success"
  );
  const reachedFailure = instances.some(
    (i) =>
      i.state === "succeeded" &&
      def.nodes.find((n) => n.key === i.nodeKey)?.type === "terminal_failure"
  );
  const anyTerminalFailure = instances.some((i) => i.state === "failed_terminal");
  const allSettled = instances.every((i) => SETTLED_NODE_STATES.includes(i.state));

  let to: WorkflowState;
  let reason: string;
  if (reachedFailure) {
    to = "failed";
    reason = "reached a terminal_failure node";
  } else if (reachedSuccess && !anyTerminalFailure) {
    to = "completed";
    reason = "reached a terminal_success node";
  } else if (anyTerminalFailure && allSettled) {
    // Some branches worked, some did not. Saying "completed" here would be the
    // undisclosed-partial-sample failure this platform exists to prevent.
    to = "partially_completed";
    reason = "some branches failed terminally; results are partial and disclosed";
  } else if (allSettled) {
    to = reachedSuccess ? "completed" : "partially_completed";
    reason = "no further work is reachable";
  } else {
    // Nothing ready, nothing parked, nothing retrying — and yet not every
    // instance is settled. The old behavior here was `completed: "no
    // reachable work remains"`, which turned a worker crash mid-node into a
    // run reported as done: the exact undisclosed-partial failure this
    // platform exists to prevent. In-flight instances get a durable wait
    // (the stale reaper in tick() flips them once their timeout + grace
    // elapses); anything else unsettled is a broken invariant and stops the
    // run safely rather than completing it.
    const inFlight = instances.filter((i) => i.state === "running").length;
    if (inFlight > 0) {
      if (run.state !== "waiting_for_dependency") {
        await sql.begin((tx) =>
          store.setRunState(tx, {
            runId: run.id,
            from: run.state,
            to: "waiting_for_dependency",
            actor: "engine",
            reason: `${inFlight} node instance(s) still in flight or awaiting stale reclaim`,
            workflowVersion,
          })
        );
      }
      await sql`
        insert into jobs (type, payload, run_after)
        values ('advance_workflow', ${sql.json({ runId: run.id } as never)},
          now() + make_interval(secs => ${EXTERNAL_WAIT_SECONDS}))
      `;
      return { state: "waiting_for_dependency", executed: 0 };
    }
    await stopSafely(
      run,
      workflowVersion,
      "unsettled node instances with no path to execution — refusing to report completion",
      "safe_stop"
    );
    return { state: "safely_stopped", executed: 0 };
  }

  const output = summariseOutput(instances);
  await sql.begin(async (tx) => {
    await store.setRunState(tx, {
      runId: run.id,
      from: run.state,
      to,
      actor: "engine",
      reason,
      workflowVersion,
      output,
    });
    if (to === "partially_completed" || to === "failed") {
      await raiseException(tx, {
        projectId: run.projectId,
        workflowRunId: run.id,
        kind: "failed_workflow",
        severity: to === "failed" ? "high" : "medium",
        summary: `Workflow ${run.definitionKey} finished ${to}: ${reason}`,
        recommendedAction:
          to === "partially_completed"
            ? "Decide whether the partial result is usable before it reaches a client."
            : "Investigate the failed node and retry.",
      });
    }
  });
  log("info", "workflow.settled", { runId: run.id, key: run.definitionKey, state: to });
  return { state: to, executed: 0 };
}

function summariseOutput(
  instances: Awaited<ReturnType<typeof store.listNodeRuns>>
): Record<string, unknown> {
  const byNode: Record<string, unknown> = {};
  for (const instance of instances) {
    if (instance.state !== "succeeded" || instance.output === null) continue;
    if (instance.fanKey === "") {
      byNode[instance.nodeKey] = instance.output;
    } else {
      const existing = (byNode[instance.nodeKey] as Record<string, unknown>) ?? {};
      existing[instance.fanKey] = instance.output;
      byNode[instance.nodeKey] = existing;
    }
  }
  return {
    nodes: byNode,
    counts: {
      succeeded: instances.filter((i) => i.state === "succeeded").length,
      failed: instances.filter((i) => i.state === "failed_terminal").length,
      skipped: instances.filter((i) => i.state === "skipped").length,
    },
  };
}

/** An approval that nobody answers must not hold a client's work open forever. */
async function checkApprovalTimeouts(run: WorkflowRun, workflowVersion: number): Promise<void> {
  const overdue = await sql`
    select a.id, a.node_run_id, n.node_key
    from workflow_approvals a
    join node_runs n on n.id = a.node_run_id
    where a.workflow_run_id = ${run.id} and a.decision is null
      and a.due_at < now()
  `;
  if (overdue.length === 0) return;
  await sql.begin(async (tx) => {
    for (const row of overdue) {
      await store.settleNodeInstance(tx, {
        nodeRunId: row.nodeRunId as string,
        runId: run.id,
        nodeKey: row.nodeKey as string,
        from: "awaiting_approval",
        to: "timed_out",
        error: `approval not decided within ${APPROVAL_TIMEOUT_HOURS}h`,
        reason: "approval timeout",
        workflowVersion,
      });
    }
    await store.setRunState(tx, {
      runId: run.id,
      from: "waiting_for_approval",
      to: "safely_stopped",
      actor: "engine",
      reason: `approval timed out after ${APPROVAL_TIMEOUT_HOURS}h`,
      workflowVersion,
      stopReason: "approval timeout",
    });
    await raiseException(tx, {
      projectId: run.projectId,
      workflowRunId: run.id,
      kind: "client_approval",
      severity: "high",
      summary: `Approval for ${run.definitionKey} timed out after ${APPROVAL_TIMEOUT_HOURS}h; the run stopped safely.`,
      recommendedAction: "Decide the approval, then restart the workflow.",
    });
  });
}

// ------------------------------------------------------------- signals

async function applySignals(
  run: WorkflowRun,
  workflowVersion: number,
  nodeDefs: Map<string, NodeDefinition & { id: string }>
): Promise<void> {
  await sql.begin(async (tx: TransactionSql) => {
    const signals = await store.consumeSignals(tx, run.id);
    for (const signal of signals) {
      if (!signal.nodeRunId) continue;
      const [node] = await tx`
        select node_key, state from node_runs where id = ${signal.nodeRunId}
      `;
      if (!node) continue;
      const nodeKey = node.nodeKey as string;
      const from = node.state as NodeState;
      const nodeDef = nodeDefs.get(nodeKey);

      if (signal.kind === "approval_decision") {
        const decision = signal.payload.decision as string;
        if (decision === "approved") {
          await store.settleNodeInstance(tx, {
            nodeRunId: signal.nodeRunId,
            runId: run.id,
            nodeKey,
            from,
            to: "succeeded",
            reason: `approved: ${(signal.payload.rationale as string) ?? ""}`.trim(),
            actor: "human",
            actorUserId: signal.sentBy,
            humanTouch: true,
            workflowVersion,
          });
        } else {
          await store.settleNodeInstance(tx, {
            nodeRunId: signal.nodeRunId,
            runId: run.id,
            nodeKey,
            from,
            to: "failed_terminal",
            error: `rejected: ${(signal.payload.rationale as string) ?? "no rationale given"}`,
            reason: "rejected by a human",
            actor: "human",
            actorUserId: signal.sentBy,
            humanTouch: true,
            workflowVersion,
          });
          const strategy = nodeDef?.failureStrategy ?? "fail_workflow";
          if (strategy !== "continue" && strategy !== "escalate") {
            await store.setRunState(tx, {
              runId: run.id,
              from: run.state,
              to: "safely_stopped",
              actor: "human",
              actorUserId: signal.sentBy,
              reason: "human rejected a required approval",
              workflowVersion,
              stopReason: "approval rejected",
            });
          }
        }
      } else if (signal.kind === "external_completion") {
        await store.settleNodeInstance(tx, {
          nodeRunId: signal.nodeRunId,
          runId: run.id,
          nodeKey,
          from,
          to: (signal.payload.ok as boolean) === false ? "failed_terminal" : "succeeded",
          output: (signal.payload.output as Record<string, unknown>) ?? {},
          reason: "external system reported completion",
          actor: "external",
          workflowVersion,
        });
      }
    }
  });
}

export async function resumeWorkflow(runId: string, signal: WorkflowSignal): Promise<void> {
  const run = await store.getRun(runId);
  if (!run) throw new ClassifiedError("not_found", `Workflow run ${runId} not found.`);
  if (isTerminal(run.state) && run.state !== "safely_stopped") {
    throw new ClassifiedError(
      "conflict",
      `Workflow run is ${run.state}; it cannot be resumed.`
    );
  }
  await sql.begin(async (tx) => {
    await store.insertSignal(tx, {
      runId,
      nodeRunId: signal.nodeRunId ?? null,
      kind: signal.kind,
      payload: signal.payload ?? {},
      sentBy: signal.sentBy ?? null,
    });
    if (run.state === "safely_stopped" || run.state === "waiting_for_approval") {
      const versionInfo = await store.versionSpec(run.versionId);
      await store.setRunState(tx, {
        runId,
        from: run.state,
        to: "running",
        actor: "human",
        actorUserId: signal.sentBy ?? null,
        reason: `resumed by signal "${signal.kind}"`,
        workflowVersion: versionInfo?.version ?? 0,
      });
    }
    await enqueueJob(tx, "advance_workflow", { runId });
  });
}

export async function cancelWorkflow(
  runId: string,
  reason: string,
  userId: string | null = null
): Promise<void> {
  const run = await store.getRun(runId);
  if (!run) throw new ClassifiedError("not_found", `Workflow run ${runId} not found.`);
  if (isTerminal(run.state)) {
    throw new ClassifiedError("conflict", `Workflow run is already ${run.state}.`);
  }
  const versionInfo = await store.versionSpec(run.versionId);
  await sql.begin(async (tx) => {
    // Cancel only what has not settled — completed work stays completed, so a
    // cancelled run is still an honest record of what happened.
    const open = await tx`
      select id, node_key, state from node_runs
      where workflow_run_id = ${runId}
        and state not in ('succeeded','failed_terminal','skipped','cancelled','timed_out')
    `;
    for (const row of open) {
      await store.settleNodeInstance(tx, {
        nodeRunId: row.id as string,
        runId,
        nodeKey: row.nodeKey as string,
        from: row.state as NodeState,
        to: "cancelled",
        reason,
        actor: "human",
        actorUserId: userId,
        humanTouch: true,
        workflowVersion: versionInfo?.version ?? 0,
      });
    }
    await store.setRunState(tx, {
      runId,
      from: run.state,
      to: "cancelled",
      actor: "human",
      actorUserId: userId,
      reason,
      workflowVersion: versionInfo?.version ?? 0,
      stopReason: reason,
    });
    await writeAudit(tx, {
      userId,
      action: "workflow.cancel",
      entity: "workflow_run",
      entityId: runId,
      detail: { reason },
    });
  });
}

/** Re-arm a terminally failed node so the next tick picks it up again. */
export async function retryNode(nodeRunId: string, userId: string | null = null): Promise<void> {
  const nodeRun = await store.getNodeRun(nodeRunId);
  if (!nodeRun) throw new ClassifiedError("not_found", "Node run not found.");
  if (nodeRun.state !== "failed_terminal" && nodeRun.state !== "timed_out") {
    throw new ClassifiedError(
      "conflict",
      `Only a failed node can be retried; this one is ${nodeRun.state}.`
    );
  }
  const run = await store.getRun(nodeRun.workflowRunId);
  if (!run) throw new ClassifiedError("not_found", "Workflow run not found.");
  const versionInfo = await store.versionSpec(run.versionId);

  await sql.begin(async (tx) => {
    await tx`update node_runs set attempts = 0, next_attempt_at = null where id = ${nodeRunId}`;
    await store.settleNodeInstance(tx, {
      nodeRunId,
      runId: run.id,
      nodeKey: nodeRun.nodeKey,
      from: nodeRun.state,
      to: "pending",
      error: null,
      reason: "manual retry",
      actor: "human",
      actorUserId: userId,
      humanTouch: true,
      workflowVersion: versionInfo?.version ?? 0,
    });
    if (isTerminal(run.state)) {
      await store.setRunState(tx, {
        runId: run.id,
        from: run.state,
        to: "running",
        actor: "human",
        actorUserId: userId,
        reason: "node retried",
        workflowVersion: versionInfo?.version ?? 0,
      });
    }
    await enqueueJob(tx, "advance_workflow", { runId: run.id });
  });
}

async function stopSafely(
  run: WorkflowRun,
  workflowVersion: number,
  reason: string,
  exceptionKind: "cost_anomaly" | "safe_stop"
): Promise<void> {
  await sql.begin(async (tx) => {
    await store.setRunState(tx, {
      runId: run.id,
      from: run.state,
      to: "safely_stopped",
      actor: "engine",
      reason,
      workflowVersion,
      stopReason: reason,
    });
    await raiseException(tx, {
      projectId: run.projectId,
      workflowRunId: run.id,
      kind: exceptionKind,
      severity: "high",
      summary: `Workflow ${run.definitionKey} stopped safely: ${reason}`,
      recommendedAction: "Raise the cap deliberately or reduce the workload, then restart.",
    });
  });
  log("warn", "workflow.safe_stop", { runId: run.id, reason });
}

/** The interface implementation — the seam a durable orchestrator would slot into. */
export const engine: WorkflowEngine = {
  registerDefinition: async (definition) => {
    const result = await registerDefinition(definition);
    return { versionId: result.versionId, created: result.created };
  },
  startWorkflow,
  resumeWorkflow,
  cancelWorkflow: (runId, reason) => cancelWorkflow(runId, reason),
  retryNode: (nodeRunId) => retryNode(nodeRunId),
  getWorkflowRun: async (runId) => {
    const run = await store.getRun(runId);
    if (!run) throw new ClassifiedError("not_found", `Workflow run ${runId} not found.`);
    return run;
  },
};
