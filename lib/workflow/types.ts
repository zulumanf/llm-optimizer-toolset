/**
 * Workflow graph types (spec 018). Pure declarations — no I/O, no SQL.
 *
 * These types are the contract between three parties that must never reach
 * into each other: the template author (writes a definition), the engine
 * (executes it), and the node handler (does one unit of work and returns
 * data). A handler never writes workflow state; the engine never invents
 * semantics.
 */

export const NODE_TYPES = [
  "deterministic_task",
  "agent_task",
  "integration_task",
  "verification_task",
  "approval_gate",
  "evidence_gate",
  "condition",
  "fan_out",
  "fan_in",
  "delay",
  "timer",
  "notification",
  "manual_task",
  "terminal_success",
  "terminal_failure",
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export const WORKFLOW_STATES = [
  "queued",
  "initializing",
  "running",
  "waiting_for_dependency",
  "waiting_for_approval",
  "waiting_for_external_system",
  "partially_completed",
  "completed",
  "failed",
  "cancelled",
  "safely_stopped",
  "timed_out",
] as const;
export type WorkflowState = (typeof WORKFLOW_STATES)[number];

export const NODE_STATES = [
  "pending",
  "ready",
  "running",
  "succeeded",
  "failed_retryable",
  "failed_terminal",
  "awaiting_verification",
  "awaiting_approval",
  "skipped",
  "cancelled",
  "timed_out",
] as const;
export type NodeState = (typeof NODE_STATES)[number];

/** A node instance that will never move again. */
export const SETTLED_NODE_STATES: readonly NodeState[] = [
  "succeeded",
  "failed_terminal",
  "skipped",
  "cancelled",
  "timed_out",
];

export type RiskLevel = "low" | "medium" | "high" | "critical";
export type FailureStrategy = "fail_workflow" | "safe_stop" | "continue" | "escalate";
export type IdempotencyStrategy = "fan_key" | "natural_key" | "none";
export type ApprovalRole = "operator" | "admin";

/** Autonomy 0-4 — see docs/architecture/automation-quality-operating-model.md */
export type AutonomyLevel = 0 | 1 | 2 | 3 | 4;

/**
 * A deterministic edge condition. Never an expression string: conditions are
 * data so they can be stored, diffed, and reasoned about without eval.
 */
export type EdgeCondition =
  | { kind: "always" }
  | { kind: "output_equals"; path: string; value: string | number | boolean }
  | { kind: "output_gte"; path: string; value: number }
  | { kind: "output_lt"; path: string; value: number }
  | { kind: "output_truthy"; path: string }
  | { kind: "node_state"; state: NodeState };

export interface NodeDefinition {
  key: string;
  type: NodeType;
  name: string;
  description?: string;
  /** Registered handler name; required for task-shaped nodes. */
  handler?: string;
  agentVersion?: string;
  allowedTools?: string[];
  requiredEvidence?: string[];
  confidenceThreshold?: number;
  timeoutSeconds?: number;
  maxAttempts?: number;
  retryBackoffSeconds?: number;
  riskLevel?: RiskLevel;
  requiresApproval?: boolean;
  approvalRole?: ApprovalRole;
  idempotencyStrategy?: IdempotencyStrategy;
  failureStrategy?: FailureStrategy;
  autonomyLevel?: AutonomyLevel;
  /** Node-type specific settings (gate type, fan-out source, delay seconds…). */
  config?: Record<string, unknown>;
}

export interface EdgeDefinition {
  from: string;
  to: string;
  condition?: EdgeCondition;
  priority?: number;
  /** A required edge blocks its target until the source succeeds. */
  required?: boolean;
  onFailure?: "block" | "skip" | "route";
  /** Present only on a deliberately bounded rework loop. */
  loop?: { maxIterations: number };
}

export interface WorkflowDefinition {
  key: string;
  name: string;
  description: string;
  actionType: string;
  autonomyLevel: AutonomyLevel;
  version: number;
  nodes: NodeDefinition[];
  edges: EdgeDefinition[];
  /** Documented in the template; surfaced in the UI, never enforced by code. */
  acceptanceCriteria?: string[];
}

// --------------------------------------------------------------- execution

export interface StartWorkflowInput {
  definitionKey: string;
  projectId?: string | null;
  input?: Record<string, unknown>;
  /** Duplicate starts with the same key collapse onto the first run. */
  idempotencyKey: string;
  trigger?: "manual" | "scheduled" | "signal" | "chained";
  costCapMicroUsd?: number;
  maxParallel?: number;
  startedBy?: string | null;
}

export interface WorkflowRun {
  id: string;
  versionId: string;
  definitionKey: string;
  workflowVersion: number;
  projectId: string | null;
  state: WorkflowState;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  stopReason: string | null;
  costMicroUsd: number;
  costCapMicroUsd: number | null;
  maxParallel: number;
  startedAt: Date;
  finishedAt: Date | null;
}

export interface NodeRun {
  id: string;
  workflowRunId: string;
  nodeId: string;
  nodeKey: string;
  fanKey: string;
  state: NodeState;
  attempts: number;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  confidence: number | null;
  costMicroUsd: number;
  error: string | null;
  humanTouch: boolean;
  nextAttemptAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface WorkflowSignal {
  kind: string;
  nodeRunId?: string | null;
  payload?: Record<string, unknown>;
  sentBy?: string | null;
}

/**
 * What a node handler receives. Note what is absent: no `sql`, no transaction,
 * no write capability. A handler proposes; the engine writes.
 */
export interface NodeContext {
  runId: string;
  projectId: string | null;
  nodeKey: string;
  fanKey: string;
  attempt: number;
  /** Merged outputs of the node's required upstream instances. */
  inputs: Record<string, unknown>;
  /** The workflow's start input. */
  workflowInput: Record<string, unknown>;
  config: Record<string, unknown>;
  node: NodeDefinition;
  /** Remaining cost budget in micro-USD; null when uncapped. */
  remainingCostMicroUsd: number | null;
}

export type NodeOutcome =
  | "succeeded"
  | "failed_retryable"
  | "failed_terminal"
  | "awaiting_approval"
  | "awaiting_verification"
  | "skipped"
  | "safe_stop";

export interface NodeResult {
  outcome: NodeOutcome;
  output?: Record<string, unknown>;
  /** Fan-out nodes return the keys their downstream nodes will run for. */
  fanKeys?: string[];
  evidenceIds?: string[];
  confidence?: number;
  costMicroUsd?: number;
  error?: string;
  /** Reason for a safe stop or an approval request — always human-readable. */
  reason?: string;
}

export type NodeHandler = (ctx: NodeContext) => Promise<NodeResult>;

/**
 * The seam that keeps a durable orchestrator substitutable (spec 018).
 * Everything outside lib/workflow/engine.ts depends on this, not on Postgres.
 */
export interface WorkflowEngine {
  registerDefinition(definition: WorkflowDefinition): Promise<{ versionId: string; created: boolean }>;
  startWorkflow(input: StartWorkflowInput): Promise<WorkflowRun>;
  resumeWorkflow(runId: string, signal: WorkflowSignal): Promise<void>;
  cancelWorkflow(runId: string, reason: string): Promise<void>;
  retryNode(nodeRunId: string): Promise<void>;
  getWorkflowRun(runId: string): Promise<WorkflowRun>;
}
