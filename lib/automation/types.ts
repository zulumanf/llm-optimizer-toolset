/**
 * Automation-layer types.
 *
 * `AutomationWorkflowDefinition` EXTENDS the spec-018 `WorkflowDefinition`
 * rather than replacing it. The added fields are operational policy — owner,
 * risk, cost ceiling, required connectors, evaluation suite — and policy must
 * not force a change to the node schema, or every policy tweak would become a
 * graph migration.
 */
import type { ConnectorCapability } from "@/lib/connectors/types";
import type {
  AutonomyLevel,
  RiskLevel,
  WorkflowDefinition,
  WorkflowRun,
  WorkflowState,
} from "@/lib/workflow/types";
import type { EventFilter } from "@/lib/events/types";
import type { MissedRunPolicy, ThresholdComparison } from "@/lib/triggers/types";

/** Which part of the business a workflow serves. Drives grouping, not logic. */
export const AUTOMATION_DOMAINS = [
  "revenue",
  "delivery",
  "authority",
  "reputation",
  "intelligence",
  "operations",
] as const;
export type AutomationDomain = (typeof AUTOMATION_DOMAINS)[number];

/** Whether a workflow runs for one client, for the platform, or either. */
export type ClientScope = "client_required" | "platform_only" | "either";

export type TriggerDeclaration =
  | {
      kind: "schedule";
      key: string;
      cron: string;
      timezone?: string;
      missedRunPolicy?: MissedRunPolicy;
      description: string;
    }
  | {
      kind: "domain_event";
      eventType: string;
      filter?: EventFilter;
      /** Rendered into the run's idempotency key. */
      idempotencyTemplate?: string;
      /** Why starting this unattended is safe. Required prose. */
      autonomyNote: string;
      description: string;
    }
  | {
      kind: "webhook";
      key: string;
      provider: string;
      eventType: string;
      description: string;
    }
  | {
      kind: "threshold";
      key: string;
      metricKey: string;
      comparison: ThresholdComparison;
      thresholdValue: number;
      lookbackDays: number;
      minimumSample: number;
      cron?: string;
      description: string;
    }
  | { kind: "manual"; description: string };

export interface AutomationWorkflowDefinition extends WorkflowDefinition {
  domain: AutomationDomain;
  clientScope: ClientScope;
  /** Who is accountable for this process. A workflow with no owner is nobody's. */
  owner: string;
  riskClassification: RiskLevel;
  triggers: TriggerDeclaration[];
  /** Zod-free shape documentation, surfaced in the UI. */
  inputSchema?: Record<string, string>;
  outputSchema?: Record<string, string>;
  maxCostMicroUsd: number;
  maxDurationMinutes: number;
  /** Concurrent node instances inside one run. */
  maxParallel: number;
  /** Concurrent runs of this workflow per client. */
  maxConcurrentRuns: number;
  retryBudget: number;
  requiredApprovals: string[];
  requiredPermissions: ("operator" | "admin")[];
  requiredConnectors: ConnectorCapability[];
  /** Named evaluation suite, when one exists. Honest null otherwise. */
  evaluationSuite: string | null;
  publishedAt?: string;
  deprecatedAt?: string | null;
}

export type RunMode = "live" | "test";

export interface StartAutomationWorkflowInput {
  workflowKey: string;
  projectId?: string | null;
  input?: Record<string, unknown>;
  idempotencyKey: string;
  mode?: RunMode;
  trigger?: "manual" | "scheduled" | "signal" | "chained";
  startedBy?: string | null;
  costCapMicroUsd?: number;
  /** Test runs only: canned connector/agent responses. */
  fixtures?: WorkflowFixtureBundle;
  /** Test runs only: permit real CRM writes. Never permits a send. */
  allowCrmWrites?: boolean;
}

/**
 * A test run's canned responses.
 *
 * These are ARRAYS OF ENTRIES, not objects keyed by capability, and that is not
 * a style choice. The database client is configured with
 * `transform: postgres.camel`, which rewrites JSON **keys** on read — a stored
 * key of `analytics.fetch_sessions` comes back as `analytics.fetchSessions`, and
 * a lookup by capability name silently misses. Capability and agent names live
 * in *values* here, where the transform cannot touch them.
 */
export interface FixtureEntry {
  /** A connector capability, e.g. `analytics.fetch_sessions`. */
  capability: string;
  response: unknown;
}

export interface AgentFixtureEntry {
  /** An agent key, e.g. `draft_outreach`, or a node key. */
  agent: string;
  response: unknown;
}

export interface WorkflowFixtureBundle {
  connectorResponses: FixtureEntry[];
  agentResponses: AgentFixtureEntry[];
}

export interface AutomationWorkflowRun extends WorkflowRun {
  mode: RunMode;
}

export interface AutomationWorkflowSignal {
  kind: string;
  nodeRunId?: string | null;
  payload?: Record<string, unknown>;
  sentBy?: string | null;
}

export interface AutomationExceptionFilters {
  projectId?: string | null;
  kind?: string;
  severity?: RiskLevel;
  status?: "open" | "acknowledged" | "resolved" | "dismissed";
  overdueOnly?: boolean;
  limit?: number;
}

export interface AutomationException {
  id: string;
  projectId: string | null;
  projectName: string | null;
  workflowRunId: string | null;
  nodeRunId: string | null;
  kind: string;
  severity: RiskLevel;
  summary: string;
  detail: Record<string, unknown>;
  recommendedAction: string;
  owner: string | null;
  status: string;
  slaHours: number;
  dueAt: Date | null;
  createdAt: Date;
  /** Deterministic priority, with its components, per spec 018's formula. */
  priority: number;
}

/**
 * The interface the request asked for. Implemented in `runtime.ts` as an
 * adapter over the spec-018 engine — see
 * docs/architecture/native-automation-runtime.md for why there is no second
 * execution model.
 */
export interface AutomationRuntime {
  registerWorkflow(definition: AutomationWorkflowDefinition): Promise<void>;
  publishWorkflowVersion(workflowKey: string, version: number): Promise<void>;
  startWorkflow(input: StartAutomationWorkflowInput): Promise<AutomationWorkflowRun>;
  signalWorkflow(workflowRunId: string, signal: AutomationWorkflowSignal): Promise<void>;
  retryNode(nodeRunId: string): Promise<void>;
  cancelWorkflow(workflowRunId: string, reason: string): Promise<void>;
  getRun(workflowRunId: string): Promise<AutomationWorkflowRun>;
  listExceptions(filters: AutomationExceptionFilters): Promise<AutomationException[]>;
}

/** Node-config contract every automation node reads from `ctx.config`. */
export interface AutomationNodeConfig {
  capability?: ConnectorCapability;
  provider?: string;
  agentVersion?: string;
  /** Where in `ctx.inputs` this node's payload comes from. */
  inputPath?: string;
  /** Static values merged into the node's payload. */
  params?: Record<string, unknown>;
  actionType?: string;
  autonomyLevel?: AutonomyLevel;
  [key: string]: unknown;
}

export type { WorkflowState };
