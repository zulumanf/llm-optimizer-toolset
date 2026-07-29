/**
 * Template-authoring helpers.
 *
 * These exist so a workflow file reads as a *graph declaration* rather than a
 * wall of defaults. Every helper's job is to make the safe choice the short one:
 * `agent()` defaults to no approval (an agent only drafts), `send()` defaults to
 * high risk and approval-required, `publish()` cannot be written without an
 * approval id. Getting the dangerous case wrong should require extra typing.
 */
import type {
  EdgeDefinition,
  NodeDefinition,
  RiskLevel,
} from "@/lib/workflow/types";
import type { AutomationAgentKey } from "@/lib/automation/prompts";
import type { ConnectorCapability } from "@/lib/connectors/types";
import type {
  AutomationWorkflowDefinition,
  AutomationDomain,
  ClientScope,
  TriggerDeclaration,
} from "@/lib/automation/types";

type NodeExtras = Partial<Omit<NodeDefinition, "key" | "type" | "name">>;

/**
 * Per-node action types.
 *
 * Spec 018 classifies `deterministic_task`, `agent_task` and `integration_task`
 * as *effectful*, and gates every effectful node behind an approval at autonomy
 * ≤ 2. Without a per-node action type, a level-2 workflow would therefore
 * demand a human decision on every read and every calculation — which
 * `lib/workflow/autonomy.ts` itself warns "would train the operator to
 * rubber-stamp, which is worse than no gate at all".
 *
 * The established convention (spec 018's own `content_production_v1`) is to set
 * `config.actionType` per node so the resolver can distinguish a computation
 * from a consequence. These defaults do that, and any template may override
 * them where a specific node deserves stricter handling.
 */
const ACTION_TYPES = {
  /** Validating and recording what started the run. No effect. */
  trigger: "routine_classification",
  /** Deterministic computation and internal reads. Reproducible, no effect. */
  computation: "metric_calculation",
  /** A connector read. Ingestion, never a change outside. */
  ingestion: "analytics_ingestion",
  /** An agent producing a draft or a classification. Reviewed downstream. */
  drafting: "content_drafting",
  /** An independent re-check. A guard, not the consequential act. */
  verification: "routine_classification",
} as const;

/** A trigger entry node. Records the run's provenance; causes nothing. */
export function trigger(
  key: string,
  kind: "schedule" | "webhook" | "domain_event" | "threshold" | "manual",
  name: string,
  extras: NodeExtras = {}
): NodeDefinition {
  return {
    key,
    type: "deterministic_task",
    name,
    handler: `trg.${kind}`,
    config: { actionType: ACTION_TYPES.trigger },
    failureStrategy: "fail_workflow",
    ...extras,
  };
}

/** A deterministic step. Reproducible; no LLM. */
export function step(
  key: string,
  handler: string,
  name: string,
  config: Record<string, unknown> = {},
  extras: NodeExtras = {}
): NodeDefinition {
  return {
    key,
    type: "deterministic_task",
    name,
    handler,
    config: { actionType: ACTION_TYPES.computation, ...config },
    failureStrategy: "safe_stop",
    ...extras,
  };
}

/**
 * An agent step. Never approval-gated by itself — an agent produces a draft, and
 * the approval belongs on the node that *acts* on the draft.
 */
export function agent(
  key: string,
  agentKey: AutomationAgentKey,
  name: string,
  config: Record<string, unknown> = {},
  extras: NodeExtras = {}
): NodeDefinition {
  return {
    key,
    type: "agent_task",
    name,
    handler: `agt.${agentKey}`,
    agentVersion: agentKey,
    config: { actionType: ACTION_TYPES.drafting, ...config },
    timeoutSeconds: 300,
    riskLevel: "low",
    requiresApproval: false,
    failureStrategy: "safe_stop",
    ...extras,
  };
}

/** A verification step — an independent re-check, with fresh context. */
export function verify(
  key: string,
  agentKey: AutomationAgentKey,
  name: string,
  config: Record<string, unknown> = {},
  extras: NodeExtras = {}
): NodeDefinition {
  return {
    key,
    type: "verification_task",
    name,
    handler: `agt.${agentKey}`,
    agentVersion: agentKey,
    config: { actionType: ACTION_TYPES.verification, ...config },
    timeoutSeconds: 300,
    failureStrategy: "safe_stop",
    ...extras,
  };
}

/** A connector read. Low risk by definition — it changes nothing outside. */
export function fetch(
  key: string,
  capability: ConnectorCapability,
  name: string,
  config: Record<string, unknown> = {},
  extras: NodeExtras = {}
): NodeDefinition {
  return {
    key,
    type: "integration_task",
    name,
    handler: `int.${capability.replace(".", "_")}`,
    config: { capability, actionType: ACTION_TYPES.ingestion, ...config },
    timeoutSeconds: 120,
    riskLevel: "low",
    // A missing analytics read should not kill a whole report; the report
    // discloses the gap instead.
    failureStrategy: "continue",
    ...extras,
  };
}

/** A connector write. High risk, approval-required, unless deliberately relaxed. */
export function act(
  key: string,
  capability: ConnectorCapability,
  name: string,
  config: Record<string, unknown> = {},
  extras: NodeExtras = {}
): NodeDefinition {
  return {
    key,
    type: "integration_task",
    name,
    handler: `int.${capability.replace(".", "_")}`,
    config: { capability, ...config },
    timeoutSeconds: 120,
    riskLevel: "high",
    failureStrategy: "safe_stop",
    ...extras,
  };
}

/** A human decision gate. Requires the evidence the approver needs. */
export function human(
  key: string,
  humanKey: string,
  name: string,
  config: Record<string, unknown> = {},
  extras: NodeExtras = {}
): NodeDefinition {
  return {
    key,
    type: "approval_gate",
    name,
    handler: `hum.${humanKey}`,
    config,
    riskLevel: "medium",
    approvalRole: "operator",
    failureStrategy: "safe_stop",
    ...extras,
  };
}

/** A control node. */
export function control(
  key: string,
  handler: string,
  name: string,
  config: Record<string, unknown> = {},
  extras: NodeExtras = {}
): NodeDefinition {
  return {
    key,
    type: handler === "ctl.evidence_gate" ? "evidence_gate" : "condition",
    name,
    handler,
    config,
    failureStrategy: "safe_stop",
    ...extras,
  };
}

export function fanOut(
  key: string,
  name: string,
  sourcePath: string,
  keyField?: string
): NodeDefinition {
  return {
    key,
    type: "fan_out",
    name,
    handler: "ctl.fan_out",
    config: { sourcePath, ...(keyField ? { keyField } : {}) },
    failureStrategy: "safe_stop",
  };
}

export function fanIn(key: string, name: string, minimumBranches = 0): NodeDefinition {
  return {
    key,
    type: "fan_in",
    name,
    config: { minimumBranches },
    failureStrategy: "continue",
  };
}

export function success(key: string, name: string): NodeDefinition {
  return { key, type: "terminal_success", name };
}

export function failure(key: string, name: string): NodeDefinition {
  return { key, type: "terminal_failure", name };
}

/** An edge. `required: false` means the target proceeds without this branch. */
export function edge(
  from: string,
  to: string,
  extras: Partial<Omit<EdgeDefinition, "from" | "to">> = {}
): EdgeDefinition {
  return { from, to, ...extras };
}

/** A conditional edge that fires when the source's `result` is true/false. */
export function branch(from: string, to: string, when: boolean): EdgeDefinition {
  return {
    from,
    to,
    condition: { kind: "output_equals", path: "result", value: when },
    // A branch not taken must not block its target forever.
    required: false,
    onFailure: "skip",
  };
}

/** A conditional edge on an arbitrary output path. */
export function when(
  from: string,
  to: string,
  path: string,
  value: string | number | boolean
): EdgeDefinition {
  return {
    from,
    to,
    condition: { kind: "output_equals", path, value },
    required: false,
    onFailure: "skip",
  };
}

export interface WorkflowSpecInput {
  key: string;
  name: string;
  description: string;
  domain: AutomationDomain;
  clientScope?: ClientScope;
  owner?: string;
  actionType: string;
  autonomyLevel: 0 | 1 | 2 | 3 | 4;
  riskClassification: RiskLevel;
  triggers: TriggerDeclaration[];
  nodes: NodeDefinition[];
  edges: EdgeDefinition[];
  acceptanceCriteria: string[];
  requiredConnectors?: ConnectorCapability[];
  requiredApprovals?: string[];
  requiredPermissions?: ("operator" | "admin")[];
  maxCostMicroUsd?: number;
  maxDurationMinutes?: number;
  maxParallel?: number;
  maxConcurrentRuns?: number;
  retryBudget?: number;
  inputSchema?: Record<string, string>;
  outputSchema?: Record<string, string>;
  evaluationSuite?: string | null;
  version?: number;
}

/**
 * Assemble a definition with defensible defaults. The cost cap defaults to
 * something small on purpose: a template author who needs more must say so, and
 * that is the moment to think about why.
 */
export function defineWorkflow(input: WorkflowSpecInput): AutomationWorkflowDefinition {
  return {
    key: input.key,
    name: input.name,
    description: input.description,
    actionType: input.actionType,
    autonomyLevel: input.autonomyLevel,
    version: input.version ?? 1,
    nodes: input.nodes,
    edges: input.edges,
    acceptanceCriteria: input.acceptanceCriteria,

    domain: input.domain,
    clientScope: input.clientScope ?? "client_required",
    owner: input.owner ?? "fulfilment operator",
    riskClassification: input.riskClassification,
    triggers: input.triggers,
    inputSchema: input.inputSchema,
    outputSchema: input.outputSchema,
    maxCostMicroUsd: input.maxCostMicroUsd ?? 2_000_000,
    maxDurationMinutes: input.maxDurationMinutes ?? 120,
    maxParallel: input.maxParallel ?? 6,
    maxConcurrentRuns: input.maxConcurrentRuns ?? 1,
    retryBudget: input.retryBudget ?? 10,
    requiredApprovals: input.requiredApprovals ?? [],
    requiredPermissions: input.requiredPermissions ?? ["operator"],
    requiredConnectors: input.requiredConnectors ?? [],
    evaluationSuite: input.evaluationSuite ?? null,
  };
}
