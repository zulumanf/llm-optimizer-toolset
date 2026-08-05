/**
 * `AutomationRuntime` — a thin adapter over the spec-018 engine.
 *
 * There is deliberately no second execution model. See
 * docs/architecture/native-automation-runtime.md: a run's state, retry
 * semantics, audit trail and "what is this waiting on?" must have exactly one
 * home, and spec 018 already built it. What this adapter adds is the vocabulary
 * and the policy the domain needs — mode, connector preflight, concurrency,
 * exception querying — none of which belong inside a graph engine.
 */
import { sql } from "@/db/client";
import * as workflowStore from "@/db/workflow";
import {
  cancelWorkflow as engineCancel,
  registerDefinition,
  resumeWorkflow as engineResume,
  retryNode as engineRetry,
  startWorkflow as engineStart,
} from "@/lib/workflow/engine";
import { validateGraph } from "@/lib/workflow/graph";
import { computePriority } from "@/lib/workflow/exceptions";
import { providersFor } from "@/lib/connectors/registry";
import * as connectorStore from "@/db/connectors";
import { forgetRunMode, TEST_CONFIG_KEY } from "@/lib/automation/testmode";
import { ClassifiedError } from "@/lib/errors";
import { log } from "@/lib/logger";
import type { RiskLevel } from "@/lib/workflow/types";
import type {
  AutomationException,
  AutomationExceptionFilters,
  AutomationWorkflowDefinition,
  AutomationWorkflowRun,
  AutomationWorkflowSignal,
  RunMode,
  StartAutomationWorkflowInput,
} from "@/lib/automation/types";

// ------------------------------------------------------------- registration

const registry = new Map<string, AutomationWorkflowDefinition>();

export function registeredWorkflows(): AutomationWorkflowDefinition[] {
  return [...registry.values()];
}

/**
 * Config keys whose value is a dotted path into another node's output. Used by
 * `validateNodePaths` to check that what a template reads is actually ordered
 * before the node reading it.
 */
const PATH_CONFIG_KEYS = new Set([
  "path",
  "sourcePath",
  "inputPath",
  "contextPath",
  "packetPath",
  "confidencePath",
  "valuePath",
  "currentPath",
  "previousPath",
  "samplePath",
  "numeratorPath",
  "denominatorPath",
  "signalsPath",
  "rowsPath",
  "idsPath",
  "contentPath",
  "expectedPath",
  "titlePath",
  "evidenceIdsPath",
  "artifactPath",
  "emailPath",
  "idPath",
  "draftPath",
  "sequenceIdPath",
  "messageIdPath",
  "sendResultPath",
  "subjectPath",
  "subjectRefPath",
  "classificationPath",
  "briefPath",
  "meetingPath",
  "summaryPath",
  "briefIdPath",
  "messagePath",
  "triagePath",
  "invoicePath",
  "contractPath",
  "actionPath",
  "metricsPath",
  "payloadPath",
  "observationsPath",
  "profilePath",
  "untilPath",
  "bodyPath",
]);

/**
 * Every node reachable backwards from `nodeKey`. A node may read the output of
 * any ancestor, because the engine merges each satisfied edge's source output
 * into the node's inputs.
 */
function ancestorsOf(definition: AutomationWorkflowDefinition, nodeKey: string): Set<string> {
  const incoming = new Map<string, string[]>();
  for (const edge of definition.edges) {
    incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge.from]);
  }
  const seen = new Set<string>();
  const queue = [...(incoming.get(nodeKey) ?? [])];
  while (queue.length > 0) {
    const key = queue.shift()!;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const parent of incoming.get(key) ?? []) queue.push(parent);
  }
  return seen;
}

/**
 * Catch a template reading a node that may not have run.
 *
 * `lib/automation/nodes/paths.ts` resolves a path from direct upstream outputs,
 * then the run input, then any node in the run that has already SUCCEEDED — so
 * reading an ancestor several hops back is fine and needs no shortcut edge.
 * (Adding one would be actively harmful: `computeReady` fires a node when *any*
 * incoming edge is satisfied, so a shortcut around a gate would let the gated
 * node run before its gate cleared.)
 *
 * What is NOT fine is reading a node that is not an ancestor at all. Nothing
 * orders it before this node, so the value may or may not exist depending on
 * scheduling — the definition of a race.
 */
export function validateNodePaths(definition: AutomationWorkflowDefinition): string[] {
  const nodeKeys = new Set(definition.nodes.map((n) => n.key));
  const errors: string[] = [];

  for (const node of definition.nodes) {
    const config = node.config ?? {};
    const ancestors = ancestorsOf(definition, node.key);
    for (const [key, value] of Object.entries(config)) {
      if (!PATH_CONFIG_KEYS.has(key) || typeof value !== "string" || value.length === 0) continue;
      const root = value.split(".")[0]!;
      // A path rooted at a run-input key (`payload`, `trigger`, `event`) reads
      // the run itself and needs no ordering.
      if (!nodeKeys.has(root)) continue;
      if (root === node.key) continue;
      if (!ancestors.has(root)) {
        errors.push(
          `node "${node.key}" reads "${value}", but "${root}" is not an ancestor of it — ` +
            "nothing orders it first, so the value may not exist when this node runs."
        );
      }
    }
  }
  return errors;
}

export function validateAutomationDefinition(
  definition: AutomationWorkflowDefinition
): string[] {
  const errors = validateGraph(definition).map((e) => e.message);
  errors.push(...validateNodePaths(definition));

  if (definition.owner.trim().length === 0) {
    errors.push("owner is required — an unowned workflow is nobody's responsibility.");
  }
  if (definition.maxCostMicroUsd <= 0) {
    errors.push("maxCostMicroUsd must be positive; an uncapped workflow can spend without bound.");
  }
  if (definition.maxDurationMinutes <= 0) {
    errors.push("maxDurationMinutes must be positive.");
  }
  if (definition.triggers.length === 0) {
    errors.push("at least one trigger must be declared, even if it is manual.");
  }
  for (const capability of definition.requiredConnectors) {
    if (providersFor(capability).length === 0) {
      errors.push(
        `requires capability "${capability}", which no registered connector implements.`
      );
    }
  }
  // An effectful workflow at autonomy 3 or 4 with no approvals is exactly the
  // configuration that sends something nobody agreed to.
  if (
    definition.autonomyLevel >= 3 &&
    definition.riskClassification === "high" &&
    definition.requiredApprovals.length === 0
  ) {
    errors.push(
      "a high-risk workflow at autonomy 3+ must declare at least one required approval."
    );
  }
  return errors;
}

export async function registerWorkflow(
  definition: AutomationWorkflowDefinition
): Promise<{ versionId: string; version: number; created: boolean }> {
  const errors = validateAutomationDefinition(definition);
  if (errors.length > 0) {
    throw new ClassifiedError(
      "validation",
      `Automation workflow "${definition.key}" is invalid: ${errors.join(" ")}`
    );
  }
  const result = await registerDefinition(definition);
  registry.set(definition.key, definition);
  return result;
}

/**
 * Mark a version published. Publication is idempotent, and deprecating a
 * version never touches its runs — a finished run points at the version it
 * executed, which is the whole reason versions are immutable.
 */
export async function publishWorkflowVersion(
  workflowKey: string,
  version: number
): Promise<void> {
  const rows = await sql`
    update workflow_versions v set status = 'published'
    where v.version = ${version}
      and v.definition_id = (select id from workflow_definitions where key = ${workflowKey})
      and v.status = 'draft'
    returning v.id
  `;
  if (rows.length === 0) {
    // Already published, or no such version. Distinguish the two honestly.
    const [existing] = await sql`
      select v.status from workflow_versions v
      join workflow_definitions d on d.id = v.definition_id
      where d.key = ${workflowKey} and v.version = ${version}
    `;
    if (!existing) {
      throw new ClassifiedError(
        "not_found",
        `Workflow "${workflowKey}" has no version ${version}.`
      );
    }
  }
  log("info", "automation.version_published", { workflowKey, version });
}

// -------------------------------------------------------------------- start

/**
 * Preflight the connectors a workflow needs. A live run whose required
 * capability has no healthy connection is refused BEFORE it starts, so the
 * failure is one clear message rather than a half-finished run and a
 * mid-graph exception.
 */
export async function connectorPreflight(args: {
  definition: AutomationWorkflowDefinition;
  projectId: string | null;
  mode: RunMode;
}): Promise<{ ok: boolean; missing: string[]; degraded: string[] }> {
  if (args.mode === "test") return { ok: true, missing: [], degraded: [] };

  const missing: string[] = [];
  const degraded: string[] = [];
  for (const capability of args.definition.requiredConnectors) {
    const candidates = providersFor(capability);
    let found = false;
    for (const provider of candidates) {
      const connection = await connectorStore.connectionFor({
        projectId: args.projectId,
        provider,
      });
      if (!connection) continue;
      found = true;
      if (connection.status !== "active") degraded.push(`${capability} (${provider}: ${connection.status})`);
      break;
    }
    if (!found) missing.push(capability);
  }
  return { ok: missing.length === 0, missing, degraded };
}

/**
 * Runs of this workflow already in flight for this client, in this mode.
 *
 * Scoped by mode on purpose: a test run must not consume a client's production
 * concurrency budget, or testing a workflow would block the real one.
 */
async function activeRunCount(
  workflowKey: string,
  projectId: string | null,
  mode: RunMode
): Promise<number> {
  const [row] = await sql`
    select count(*)::int as n
    from workflow_runs r
    join workflow_versions v on v.id = r.version_id
    join workflow_definitions d on d.id = v.definition_id
    where d.key = ${workflowKey}
      and r.mode = ${mode}
      and (${projectId ?? null}::uuid is null or r.project_id = ${projectId ?? null})
      and r.state not in ('completed','failed','cancelled','safely_stopped','timed_out','partially_completed')
  `;
  return Number(row?.n ?? 0);
}

/**
 * Whether this exact start has already happened. A duplicate start is the SAME
 * run, so it must not be judged against the concurrency limit — otherwise a
 * retried trigger would fail instead of collapsing onto the run it already
 * created.
 */
async function existingRunFor(idempotencyKey: string): Promise<string | null> {
  const [row] = await sql`
    select id from workflow_runs where idempotency_key = ${idempotencyKey}
  `;
  return (row?.id as string) ?? null;
}

export async function startWorkflow(
  input: StartAutomationWorkflowInput
): Promise<AutomationWorkflowRun> {
  const definition = registry.get(input.workflowKey);
  if (!definition) {
    throw new ClassifiedError(
      "not_found",
      `Workflow "${input.workflowKey}" is not registered. Call bootstrapAutomation() first.`
    );
  }
  const mode: RunMode = input.mode ?? "live";
  const projectId = input.projectId ?? null;

  if (definition.clientScope === "client_required" && projectId === null) {
    throw new ClassifiedError(
      "validation",
      `Workflow "${definition.key}" runs per client and requires a projectId.`
    );
  }
  if (definition.clientScope === "platform_only" && projectId !== null) {
    throw new ClassifiedError(
      "validation",
      `Workflow "${definition.key}" is platform-scoped and must not be given a projectId.`
    );
  }

  // The engine's own idempotency key. Prefixed with the mode so a test run can
  // never collapse onto a production run of the same logical work.
  const engineKey = `${mode}:${input.idempotencyKey}`;
  const alreadyStarted = await existingRunFor(engineKey);

  // Concurrency and preflight apply to genuinely NEW work only. A duplicate
  // start is the same run, and re-checking it would turn a harmless retry into
  // a failure.
  if (!alreadyStarted) {
    const inFlight = await activeRunCount(definition.key, projectId, mode);
    if (inFlight >= definition.maxConcurrentRuns) {
      throw new ClassifiedError(
        "conflict",
        `${definition.key} already has ${inFlight} ${mode} run(s) in flight for this scope (limit ${definition.maxConcurrentRuns}).`
      );
    }
  }

  const preflight = await connectorPreflight({ definition, projectId, mode });
  if (!preflight.ok) {
    throw new ClassifiedError(
      "validation",
      `${definition.key} cannot start: no connected provider for ${preflight.missing.join(", ")}. ` +
        "Connect the provider, or start the workflow in test mode."
    );
  }

  // Test-mode configuration travels in the run input under a reserved key, so
  // the engine needs no knowledge of it and a test run stays fully replayable
  // from its own stored row.
  const runInput: Record<string, unknown> = { ...(input.input ?? {}) };
  if (mode === "test") {
    runInput[TEST_CONFIG_KEY] = {
      fixtures: input.fixtures ?? { connectorResponses: [], agentResponses: [] },
      allowCrmWrites: input.allowCrmWrites === true,
    };
  }

  const run = await engineStart({
    definitionKey: definition.key,
    projectId,
    input: runInput,
    idempotencyKey: engineKey,
    trigger: input.trigger ?? "manual",
    costCapMicroUsd: input.costCapMicroUsd ?? definition.maxCostMicroUsd,
    maxParallel: definition.maxParallel,
    startedBy: input.startedBy ?? null,
  });

  // The mode column is the durable distinction between test and production.
  await sql`update workflow_runs set mode = ${mode} where id = ${run.id}`;
  forgetRunMode(run.id);

  if (preflight.degraded.length > 0) {
    log("warn", "automation.start_with_degraded_connectors", {
      workflowKey: definition.key,
      runId: run.id,
      degraded: preflight.degraded,
    });
  }

  return { ...run, mode };
}

// ------------------------------------------------------------------ queries

export async function getRun(workflowRunId: string): Promise<AutomationWorkflowRun> {
  const run = await workflowStore.getRun(workflowRunId);
  if (!run) {
    throw new ClassifiedError("not_found", `Workflow run ${workflowRunId} not found.`);
  }
  const [row] = await sql`select mode from workflow_runs where id = ${workflowRunId}`;
  return { ...run, mode: ((row?.mode as RunMode | undefined) ?? "live") };
}

export async function listExceptions(
  filters: AutomationExceptionFilters
): Promise<AutomationException[]> {
  const limit = Math.min(filters.limit ?? 100, 500);
  const rows = await sql`
    select e.*, p.name as project_name
    from workflow_exceptions e
    left join projects p on p.id = e.project_id
    where (${filters.projectId ?? null}::uuid is null or e.project_id = ${filters.projectId ?? null})
      and (${filters.kind ?? null}::text is null or e.kind = ${filters.kind ?? null})
      and (${filters.severity ?? null}::text is null or e.severity = ${filters.severity ?? null})
      and (${filters.status ?? null}::text is null or e.status = ${filters.status ?? null})
      and (${filters.overdueOnly ?? false} = false or e.due_at < now())
    order by e.created_at desc
    limit ${limit}
  `;

  return rows
    .map((row) => {
      const dueAt = (row.dueAt as Date | null) ?? null;
      const hoursUntilDue =
        dueAt === null ? null : (dueAt.getTime() - Date.now()) / 3_600_000;
      const detail = (row.detail as Record<string, unknown>) ?? {};
      // Commercial value and dependency impact come from the raiser when it
      // knows them; the formula's components are always visible either way.
      const breakdown = computePriority({
        severity: row.severity as RiskLevel,
        hoursUntilDue,
        commercialValue: Number(detail.commercialValue ?? 0.3),
        dependencyImpact: Number(detail.dependencyImpact ?? 0.3),
        risk: Number(detail.risk ?? 0.3),
        effortMinutes: Number(detail.effortMinutes ?? 30),
      });
      return {
        id: row.id as string,
        projectId: (row.projectId as string | null) ?? null,
        projectName: (row.projectName as string | null) ?? null,
        workflowRunId: (row.workflowRunId as string | null) ?? null,
        nodeRunId: (row.nodeRunId as string | null) ?? null,
        kind: row.kind as string,
        severity: row.severity as RiskLevel,
        summary: row.summary as string,
        detail,
        recommendedAction: (row.recommendedAction as string) ?? "",
        owner: (row.owner as string | null) ?? null,
        status: row.status as string,
        slaHours: Number(row.slaHours ?? 24),
        dueAt,
        createdAt: row.createdAt as Date,
        priority: breakdown.total,
      };
    })
    .sort((a, b) => b.priority - a.priority);
}

// ---------------------------------------------------------------- lifecycle

export async function signalWorkflow(
  workflowRunId: string,
  signal: AutomationWorkflowSignal
): Promise<void> {
  await engineResume(workflowRunId, signal);
  forgetRunMode(workflowRunId);
}

export async function cancelWorkflow(
  workflowRunId: string,
  reason: string,
  userId: string | null = null
): Promise<void> {
  await engineCancel(workflowRunId, reason, userId);
  forgetRunMode(workflowRunId);
}

export async function retryNode(nodeRunId: string, userId: string | null = null): Promise<void> {
  await engineRetry(nodeRunId, userId);
}

