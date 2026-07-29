/**
 * Test mode.
 *
 * The rule: a test run may compute anything and change nothing outside the
 * platform. Production and test runs are distinguished at the database level
 * (`workflow_runs.mode`), never by convention, because "I thought this was a
 * test" is not a defence after an email reaches a prospect.
 *
 * The run's mode is cached per process for the duration of a tick. Node
 * handlers get it from here rather than being handed it, so a new node cannot
 * accidentally bypass the check by forgetting a parameter.
 */
import { sql } from "@/db/client";
import { ClassifiedError } from "@/lib/errors";
import { redactSecrets } from "@/lib/security/envelope";
import { isConsequential, type ConnectorCapability } from "@/lib/connectors/types";
import type {
  AgentFixtureEntry,
  FixtureEntry,
  RunMode,
  WorkflowFixtureBundle,
} from "@/lib/automation/types";

/**
 * The reserved key under which a test run's configuration travels in the run
 * input. Deliberately camelCase with no leading underscores: the database
 * client's `transform: postgres.camel` rewrites JSON keys on read, and a key
 * like `__test` comes back as `_Test`.
 */
export const TEST_CONFIG_KEY = "automationTestConfig";

export interface RunModeContext {
  mode: RunMode;
  /** Capability → canned response, rebuilt from the stored entry array. */
  fixtures: {
    connectorResponses: Record<string, unknown>;
    agentResponses: Record<string, unknown>;
  };
  allowCrmWrites: boolean;
}

const cache = new Map<string, RunModeContext>();

/** Rebuild a name→response lookup from the transform-proof entry array. */
function indexEntries<T extends Record<string, unknown>>(
  entries: unknown,
  nameField: keyof T & string
): Record<string, unknown> {
  if (!Array.isArray(entries)) return {};
  const out: Record<string, unknown> = {};
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") continue;
    const name = (entry as Record<string, unknown>)[nameField];
    if (typeof name === "string" && name.length > 0) {
      out[name] = (entry as Record<string, unknown>).response;
    }
  }
  return out;
}

/**
 * Read a run's mode and fixtures. Cached because a tick asks repeatedly, and
 * invalidated by `forgetRunMode` when a run settles.
 */
export async function runModeFor(runId: string): Promise<RunModeContext> {
  const cached = cache.get(runId);
  if (cached) return cached;

  const [row] = await sql`
    select mode, input from workflow_runs where id = ${runId}
  `;
  const input = (row?.input as Record<string, unknown> | undefined) ?? {};
  const testConfig = (input[TEST_CONFIG_KEY] as Record<string, unknown> | undefined) ?? {};
  const bundle = (testConfig.fixtures as WorkflowFixtureBundle | undefined) ?? {
    connectorResponses: [],
    agentResponses: [],
  };
  const context: RunModeContext = {
    mode: (row?.mode as RunMode | undefined) ?? "live",
    fixtures: {
      connectorResponses: indexEntries(bundle.connectorResponses, "capability"),
      agentResponses: indexEntries(bundle.agentResponses, "agent"),
    },
    allowCrmWrites: testConfig.allowCrmWrites === true,
  };
  cache.set(runId, context);
  return context;
}

/** Build a bundle from plain objects, for callers that find entries awkward. */
export function fixtureBundle(args: {
  connectors?: Record<string, unknown>;
  agents?: Record<string, unknown>;
}): WorkflowFixtureBundle {
  return {
    connectorResponses: Object.entries(args.connectors ?? {}).map(([capability, response]) => ({
      capability,
      response,
    })),
    agentResponses: Object.entries(args.agents ?? {}).map(([agent, response]) => ({
      agent,
      response,
    })),
  };
}

export function forgetRunMode(runId: string): void {
  cache.delete(runId);
}

/** Test seam. */
export function resetRunModeCache(): void {
  cache.clear();
}

/**
 * Hard guard for a consequential action. Throws rather than returning a
 * boolean: a caller that ignores a boolean is exactly the failure this
 * prevents.
 */
export function assertNotTestMode(context: RunModeContext, action: string): void {
  if (context.mode === "test") {
    throw new ClassifiedError(
      "forbidden",
      `"${action}" has an irreversible external effect and cannot run in test mode.`
    );
  }
}

/** Whether a capability may execute at all in this run's mode. */
export function capabilityAllowed(
  context: RunModeContext,
  capability: ConnectorCapability
): { allowed: boolean; reason: string } {
  if (context.mode === "live") return { allowed: true, reason: "live run" };
  if (isConsequential(capability)) {
    return {
      allowed: false,
      reason: `${capability} is consequential; test mode records the intended payload instead of sending it`,
    };
  }
  return { allowed: true, reason: "test run served from fixtures" };
}

/**
 * Record an action a test run declined to take. The ledger is the point of a
 * test run — "what would this have done" is the question it exists to answer.
 */
export async function recordWouldHaveHappened(args: {
  workflowRunId: string;
  nodeRunId?: string | null;
  capability: string;
  payload: Record<string, unknown>;
  reason: string;
  estimatedCostMicroUsd?: number;
}): Promise<void> {
  await sql`
    insert into workflow_test_actions (
      workflow_run_id, node_run_id, capability, would_have_sent, reason,
      estimated_cost_micro_usd
    ) values (
      ${args.workflowRunId}, ${args.nodeRunId ?? null}, ${args.capability},
      ${sql.json(redactSecrets(args.payload) as never)}, ${args.reason},
      ${args.estimatedCostMicroUsd ?? 0}
    )
  `;
}

export interface TestAction {
  id: string;
  nodeRunId: string | null;
  capability: string;
  wouldHaveSent: Record<string, unknown>;
  reason: string;
  estimatedCostMicroUsd: number;
  createdAt: Date;
}

export async function testActionsFor(workflowRunId: string): Promise<TestAction[]> {
  const rows = await sql`
    select id, node_run_id, capability, would_have_sent, reason,
           estimated_cost_micro_usd, created_at
    from workflow_test_actions
    where workflow_run_id = ${workflowRunId}
    order by created_at asc
  `;
  return rows.map((row) => ({
    id: row.id as string,
    nodeRunId: (row.nodeRunId as string | null) ?? null,
    capability: row.capability as string,
    wouldHaveSent: (row.wouldHaveSent as Record<string, unknown>) ?? {},
    reason: (row.reason as string) ?? "",
    estimatedCostMicroUsd: Number(row.estimatedCostMicroUsd ?? 0),
    createdAt: row.createdAt as Date,
  }));
}

// ------------------------------------------------------------- fixtures

export interface StoredFixture {
  id: string;
  workflowKey: string;
  name: string;
  description: string;
  input: Record<string, unknown>;
  /** Entry arrays, for the same transform-safety reason as the bundle type. */
  connectorResponses: FixtureEntry[];
  agentResponses: AgentFixtureEntry[];
}

function toStored(row: Record<string, unknown>): StoredFixture {
  return {
    id: row.id as string,
    workflowKey: row.workflowKey as string,
    name: row.name as string,
    description: (row.description as string) ?? "",
    input: (row.input as Record<string, unknown>) ?? {},
    connectorResponses: Array.isArray(row.connectorResponses)
      ? (row.connectorResponses as FixtureEntry[])
      : [],
    agentResponses: Array.isArray(row.agentResponses)
      ? (row.agentResponses as AgentFixtureEntry[])
      : [],
  };
}

export async function upsertFixture(fixture: Omit<StoredFixture, "id">): Promise<string> {
  const [row] = await sql`
    insert into workflow_fixtures (
      workflow_key, name, description, input, connector_responses, agent_responses
    ) values (
      ${fixture.workflowKey}, ${fixture.name}, ${fixture.description},
      ${sql.json(fixture.input as never)},
      ${sql.json(fixture.connectorResponses as never)},
      ${sql.json(fixture.agentResponses as never)}
    )
    on conflict (workflow_key, name) do update set
      description = excluded.description,
      input = excluded.input,
      connector_responses = excluded.connector_responses,
      agent_responses = excluded.agent_responses
    returning id
  `;
  return row!.id as string;
}

export async function getFixture(
  workflowKey: string,
  name: string
): Promise<StoredFixture | null> {
  const [row] = await sql`
    select * from workflow_fixtures
    where workflow_key = ${workflowKey} and name = ${name}
  `;
  return row ? toStored(row) : null;
}

export async function listFixtures(workflowKey?: string): Promise<StoredFixture[]> {
  const rows = await sql`
    select * from workflow_fixtures
    where (${workflowKey ?? null}::text is null or workflow_key = ${workflowKey ?? null})
    order by workflow_key, name
  `;
  return rows.map(toStored);
}

/** A stored fixture, ready to hand to `startWorkflow`. */
export function bundleFromStored(fixture: StoredFixture): WorkflowFixtureBundle {
  return {
    connectorResponses: fixture.connectorResponses,
    agentResponses: fixture.agentResponses,
  };
}
