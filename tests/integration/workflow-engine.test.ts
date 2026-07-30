/**
 * Integration tests for the graph execution engine (spec 018).
 *
 * These run against a real Postgres because the properties under test —
 * idempotency, durable pause/resume across a restart, transactional state
 * transitions, tenant isolation — are properties of the database, not of the
 * TypeScript. Asserting them with mocks would prove nothing.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { WorkflowDefinition, NodeResult } from "@/lib/workflow/types";
import { seedTestActors } from "../helpers/actors";

const TEST_URL = process.env.TEST_DATABASE_URL;
const ROOT = join(__dirname, "..", "..");

const OPERATOR = "00000000-0000-4000-8000-000000009001";

describe.skipIf(!TEST_URL)("workflow engine (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let engine: typeof import("@/lib/workflow/engine");
  let handlers: typeof import("@/lib/workflow/handlers");
  let store: typeof import("@/db/workflow");
  let jobs: typeof import("@/db/jobs");
  let projectSvc: typeof import("@/lib/projects/service");

  /** Per-test recording of what each handler was asked to do. */
  let calls: { node: string; fanKey: string; attempt: number }[] = [];
  /** Behaviour overrides keyed by node key, set per test. */
  let behaviour: Record<string, (attempt: number, fanKey: string) => NodeResult> = {};

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    engine = await import("@/lib/workflow/engine");
    handlers = await import("@/lib/workflow/handlers");
    store = await import("@/db/workflow");
    jobs = await import("@/db/jobs");
    projectSvc = await import("@/lib/projects/service");

    await sql.unsafe("drop schema public cascade; create schema public;");
    execSync(`npx tsx scripts/migrate.ts up --db "${TEST_URL}"`, { cwd: ROOT, stdio: "pipe" });
    await seedTestActors(sql);
  });

  beforeEach(async () => {
    await sql.unsafe(
      `truncate audit_log, jobs, workflow_transitions, workflow_signals,
       workflow_approvals, workflow_exceptions, quality_gate_results, node_runs,
       workflow_runs, workflow_edges, workflow_nodes, workflow_versions,
       workflow_definitions, autonomy_policies, agent_evaluations, agent_versions,
       agent_definitions, evidence_packets, claim_contradictions, claim_versions,
       action_outcomes, outcome_relationships, client_health_snapshots,
       operator_capacity_snapshots, executive_briefs, claims, projects cascade`
    );
    calls = [];
    behaviour = {};
    handlers.resetHandlers();
    registerTestHandlers();
  });

  afterAll(async () => {
    await sql.end();
  });

  function registerTestHandlers(): void {
    const record = (nodeKey: string) => async (ctx: {
      nodeKey: string;
      fanKey: string;
      attempt: number;
    }): Promise<NodeResult> => {
      calls.push({ node: nodeKey, fanKey: ctx.fanKey, attempt: ctx.attempt });
      const override = behaviour[nodeKey];
      if (override) return override(ctx.attempt, ctx.fanKey);
      return { outcome: "succeeded", output: { ok: true, node: nodeKey } };
    };
    handlers.registerHandlers({
      "test.a": record("a"),
      "test.split": async (ctx) => {
        calls.push({ node: "split", fanKey: ctx.fanKey, attempt: ctx.attempt });
        const override = behaviour.split;
        if (override) return override(ctx.attempt, ctx.fanKey);
        return { outcome: "succeeded", output: { ok: true }, fanKeys: ["p1", "p2", "p3"] };
      },
      "test.work": record("work"),
      "test.gate": record("gate"),
      "test.after": record("after"),
    });
  }

  /**
   * Drive the queue the way the worker does. Returns the number of ticks so a
   * test can assert the engine converged rather than spun.
   */
  async function drain(maxTicks = 200): Promise<number> {
    let ticks = 0;
    for (let i = 0; i < maxTicks; i += 1) {
      const job = await jobs.claimNextJob("test-worker");
      if (!job) return ticks;
      if (job.type === "advance_workflow") {
        ticks += 1;
        await engine.advanceWorkflow(job.payload.runId as string);
      }
      await jobs.completeJob(job.id);
    }
    return ticks;
  }

  async function newProject(name: string): Promise<string> {
    const result = await projectSvc.createProject(
      { id: OPERATOR, email: "op@test.local", name: "Op", role: "admin" },
      { name }
    );
    if (!result.ok) throw new Error(result.error.message);
    return result.data.id;
  }

  // ------------------------------------------------------------- fixtures

  const fanGraph = (overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition => ({
    key: "fan_test",
    name: "Fan test",
    description: "",
    actionType: "benchmark_execution", // autonomy 4 — no approval unless asked
    autonomyLevel: 4,
    version: 1,
    nodes: [
      { key: "a", type: "deterministic_task", name: "A", handler: "test.a" },
      { key: "split", type: "fan_out", name: "Split", handler: "test.split" },
      { key: "work", type: "deterministic_task", name: "Work", handler: "test.work" },
      { key: "join", type: "fan_in", name: "Join", config: { minimumBranches: 1 } },
      { key: "gate", type: "evidence_gate", name: "Gate", handler: "test.gate" },
      { key: "done", type: "terminal_success", name: "Done" },
    ],
    edges: [
      { from: "a", to: "split" },
      { from: "split", to: "work" },
      { from: "work", to: "join" },
      { from: "join", to: "gate" },
      { from: "gate", to: "done" },
    ],
    ...overrides,
  });

  const approvalGraph = (): WorkflowDefinition => ({
    key: "approval_test",
    name: "Approval test",
    description: "",
    actionType: "cms_publishing", // autonomy 2 — approval required
    autonomyLevel: 2,
    version: 1,
    nodes: [
      {
        key: "a",
        type: "deterministic_task",
        name: "Prepare",
        handler: "test.a",
        // Preparing is not publishing. Real templates name each node's own
        // action type so the approval lands on the consequential step only.
        config: { actionType: "metric_calculation" },
      },
      {
        key: "approval",
        type: "approval_gate",
        name: "Publish approval",
        requiresApproval: true,
        approvalRole: "operator",
        riskLevel: "high",
        config: { summary: "Publish the asset?" },
      },
      {
        key: "after",
        type: "deterministic_task",
        name: "After",
        handler: "test.after",
        config: { actionType: "metric_calculation" },
      },
      { key: "done", type: "terminal_success", name: "Done" },
    ],
    edges: [
      { from: "a", to: "approval" },
      { from: "approval", to: "after" },
      { from: "after", to: "done" },
    ],
  });

  // ------------------------------------------------------- registration

  it("publishes a version and refuses to publish an invalid graph", async () => {
    const first = await engine.registerDefinition(fanGraph());
    expect(first.created).toBe(true);
    expect(first.version).toBe(1);

    // Identical graph — no new version, because nothing changed.
    const second = await engine.registerDefinition(fanGraph());
    expect(second.created).toBe(false);
    expect(second.versionId).toBe(first.versionId);

    // Changed graph — a NEW version; the old one is untouched.
    const changed = fanGraph();
    changed.nodes.push({
      key: "extra",
      type: "deterministic_task",
      name: "Extra",
      handler: "test.after",
    });
    changed.edges.push({ from: "gate", to: "extra" });
    const third = await engine.registerDefinition(changed);
    expect(third.created).toBe(true);
    expect(third.version).toBe(2);

    await expect(
      engine.registerDefinition({
        ...fanGraph(),
        key: "broken",
        edges: [{ from: "a", to: "nowhere" }],
      })
    ).rejects.toThrow(/not a valid graph/);
  });

  it("keeps a published version immutable", async () => {
    const { versionId } = await engine.registerDefinition(fanGraph());
    await expect(
      sql`update workflow_versions set status = 'deprecated' where id = ${versionId}`
    ).rejects.toThrow();
    await expect(sql`delete from workflow_versions where id = ${versionId}`).rejects.toThrow();
  });

  // ------------------------------------------------------------ execution

  it("runs a fan-out/fan-in graph to completion, one instance per key", async () => {
    await engine.registerDefinition(fanGraph());
    const projectId = await newProject("Fan client");
    const run = await engine.startWorkflow({
      definitionKey: "fan_test",
      projectId,
      idempotencyKey: "fan-run-1",
    });

    await drain();
    const final = await store.getRun(run.id);
    expect(final?.state).toBe("completed");

    const workCalls = calls.filter((c) => c.node === "work");
    expect(workCalls.map((c) => c.fanKey).sort()).toEqual(["p1", "p2", "p3"]);

    const nodeRuns = await store.listNodeRuns(run.id);
    expect(nodeRuns.filter((n) => n.nodeKey === "work")).toHaveLength(3);
    expect(nodeRuns.every((n) => n.state === "succeeded")).toBe(true);

    // The fan-in disclosed what it joined.
    const join = nodeRuns.find((n) => n.nodeKey === "join")!;
    expect(join.output).toMatchObject({ completed: 3, failed: 0, partial: false });
  });

  it("records every transition with previous state, actor, reason, and version", async () => {
    await engine.registerDefinition(fanGraph());
    const projectId = await newProject("Transitions");
    const run = await engine.startWorkflow({
      definitionKey: "fan_test",
      projectId,
      idempotencyKey: "transitions-1",
    });
    await drain();

    const rows = await sql`
      select scope, from_state, to_state, actor, reason, workflow_version, node_version
      from workflow_transitions where workflow_run_id = ${run.id} order by id asc
    `;
    expect(rows.length).toBeGreaterThan(5);
    expect(rows[0]).toMatchObject({ scope: "workflow", fromState: "queued", toState: "initializing" });
    for (const row of rows) {
      expect(row.actor).toBeTruthy();
      expect(Number(row.workflowVersion)).toBe(1);
    }
    // Append-only.
    await expect(
      sql`update workflow_transitions set reason = 'tampered' where workflow_run_id = ${run.id}`
    ).rejects.toThrow();
  });

  it("collapses a duplicate start onto the first run", async () => {
    await engine.registerDefinition(fanGraph());
    const projectId = await newProject("Dedup");
    const first = await engine.startWorkflow({
      definitionKey: "fan_test",
      projectId,
      idempotencyKey: "same-key",
    });
    const second = await engine.startWorkflow({
      definitionKey: "fan_test",
      projectId,
      idempotencyKey: "same-key",
    });
    expect(second.id).toBe(first.id);
    const rows = await sql`select count(*)::int as count from workflow_runs`;
    expect(Number(rows[0]!.count)).toBe(1);
  });

  it("does not duplicate completed work when a node is re-offered", async () => {
    await engine.registerDefinition(fanGraph());
    const projectId = await newProject("Idempotency");
    const run = await engine.startWorkflow({
      definitionKey: "fan_test",
      projectId,
      idempotencyKey: "idem-1",
    });
    await drain();

    const before = calls.filter((c) => c.node === "work").length;
    // Extra ticks after completion must be inert.
    await engine.advanceWorkflow(run.id);
    await engine.advanceWorkflow(run.id);
    expect(calls.filter((c) => c.node === "work").length).toBe(before);

    const nodeRuns = await store.listNodeRuns(run.id);
    expect(nodeRuns.filter((n) => n.nodeKey === "work")).toHaveLength(3);
  });

  it("retries a failing node with backoff, then settles it terminally", async () => {
    let attempts = 0;
    behaviour.gate = (attempt) => {
      attempts = attempt;
      return { outcome: "failed_retryable", error: "transient provider error" };
    };
    await engine.registerDefinition({
      ...fanGraph(),
      key: "retry_test",
      nodes: fanGraph().nodes.map((n) =>
        n.key === "gate" ? { ...n, maxAttempts: 2, retryBackoffSeconds: 0 } : n
      ),
    });
    const projectId = await newProject("Retry");
    const run = await engine.startWorkflow({
      definitionKey: "retry_test",
      projectId,
      idempotencyKey: "retry-1",
    });
    await drain();

    const nodeRuns = await store.listNodeRuns(run.id);
    const gate = nodeRuns.find((n) => n.nodeKey === "gate")!;
    expect(gate.state).toBe("failed_terminal");
    expect(gate.attempts).toBe(2);
    expect(attempts).toBe(2);

    const final = await store.getRun(run.id);
    expect(final?.state).toBe("failed");

    // A terminal failure raises exactly one exception, not one per tick.
    const raised = await sql`
      select count(*)::int as count from workflow_exceptions
      where workflow_run_id = ${run.id} and kind = 'failed_workflow'
        and node_run_id is not null
    `;
    expect(Number(raised[0]!.count)).toBe(1);
  });

  it("discloses a partial result rather than reporting success", async () => {
    behaviour.work = (_attempt, fanKey) =>
      fanKey === "p2"
        ? { outcome: "failed_terminal", error: "provider outage" }
        : { outcome: "succeeded", output: { ok: true } };

    await engine.registerDefinition({
      ...fanGraph(),
      key: "partial_test",
      nodes: fanGraph().nodes.map((n) =>
        n.key === "work" ? { ...n, failureStrategy: "continue", maxAttempts: 1 } : n
      ),
    });
    const projectId = await newProject("Partial");
    const run = await engine.startWorkflow({
      definitionKey: "partial_test",
      projectId,
      idempotencyKey: "partial-1",
    });
    await drain();

    const nodeRuns = await store.listNodeRuns(run.id);
    const join = nodeRuns.find((n) => n.nodeKey === "join")!;
    expect(join.state).toBe("succeeded");
    expect(join.output).toMatchObject({
      completed: 2,
      failed: 1,
      partial: true,
      partialDisclosed: true,
    });

    const final = await store.getRun(run.id);
    expect(final?.state).toBe("partially_completed");
  });

  it("stops safely — not failed — when a handler declares insufficient evidence", async () => {
    behaviour.gate = () => ({
      outcome: "safe_stop",
      reason: "sample below the minimum; refusing to score",
    });
    await engine.registerDefinition({ ...fanGraph(), key: "safestop_test" });
    const projectId = await newProject("Safe stop");
    const run = await engine.startWorkflow({
      definitionKey: "safestop_test",
      projectId,
      idempotencyKey: "safestop-1",
    });
    await drain();

    const final = await store.getRun(run.id);
    expect(final?.state).toBe("safely_stopped");
    expect(final?.stopReason).toContain("sample below the minimum");

    const [exception] = await sql`
      select kind, severity, summary from workflow_exceptions
      where workflow_run_id = ${run.id} and kind = 'safe_stop'
    `;
    expect(exception).toBeDefined();
    expect(exception!.summary).toContain("sample below the minimum");
  });

  // ------------------------------------------------- approvals & autonomy

  it("pauses durably at an approval and resumes on the signal", async () => {
    await engine.registerDefinition(approvalGraph());
    const projectId = await newProject("Approval client");
    const run = await engine.startWorkflow({
      definitionKey: "approval_test",
      projectId,
      idempotencyKey: "approval-1",
    });
    await drain();

    // Parked, not finished. Downstream work has NOT run.
    let state = await store.getRun(run.id);
    expect(state?.state).toBe("waiting_for_approval");
    expect(calls.some((c) => c.node === "after")).toBe(false);

    const [approval] = await sql`
      select id, node_run_id, required_role, risk_level, due_at
      from workflow_approvals where workflow_run_id = ${run.id}
    `;
    expect(approval).toBeDefined();
    expect(approval!.requiredRole).toBe("operator");
    expect(approval!.dueAt).toBeTruthy();

    // Simulate a process restart: nothing in memory survives, and the run is
    // still exactly where it was.
    const reloaded = await store.getRun(run.id);
    expect(reloaded?.state).toBe("waiting_for_approval");

    await sql.begin((tx) =>
      store.decideApproval(tx, {
        approvalId: approval!.id as string,
        decision: "approved",
        decidedBy: OPERATOR,
        rationale: "Reviewed the draft; the claims check out.",
      })
    );
    await engine.resumeWorkflow(run.id, {
      kind: "approval_decision",
      nodeRunId: approval!.nodeRunId as string,
      payload: { decision: "approved", rationale: "Reviewed the draft." },
      sentBy: OPERATOR,
    });
    await drain();

    state = await store.getRun(run.id);
    expect(state?.state).toBe("completed");
    expect(calls.some((c) => c.node === "after")).toBe(true);

    // The decision is evidence: immutable, and attributed.
    const nodeRuns = await store.listNodeRuns(run.id);
    const approvalNode = nodeRuns.find((n) => n.nodeKey === "approval")!;
    expect(approvalNode.state).toBe("succeeded");
    expect(approvalNode.humanTouch).toBe(true);
  });

  it("stops safely when a human rejects", async () => {
    await engine.registerDefinition(approvalGraph());
    const projectId = await newProject("Rejection");
    const run = await engine.startWorkflow({
      definitionKey: "approval_test",
      projectId,
      idempotencyKey: "reject-1",
    });
    await drain();

    const [approval] = await sql`
      select id, node_run_id from workflow_approvals where workflow_run_id = ${run.id}
    `;
    await engine.resumeWorkflow(run.id, {
      kind: "approval_decision",
      nodeRunId: approval!.nodeRunId as string,
      payload: { decision: "rejected", rationale: "The transaction figure is unsupported." },
      sentBy: OPERATOR,
    });
    await drain();

    const state = await store.getRun(run.id);
    expect(state?.state).toBe("safely_stopped");
    expect(calls.some((c) => c.node === "after")).toBe(false);
  });

  it("enforces autonomy: a level-2 action cannot succeed without approval", async () => {
    // The node is an ordinary task, but its action type is approval-gated.
    const graph: WorkflowDefinition = {
      key: "autonomy_test",
      name: "Autonomy test",
      description: "",
      actionType: "cms_publishing",
      autonomyLevel: 2,
      version: 1,
      nodes: [
        {
          key: "a",
          type: "deterministic_task",
          name: "Publish",
          handler: "test.a",
          riskLevel: "high",
          config: { actionType: "cms_publishing" },
        },
        { key: "done", type: "terminal_success", name: "Done" },
      ],
      edges: [{ from: "a", to: "done" }],
    };
    await engine.registerDefinition(graph);
    const projectId = await newProject("Autonomy");
    const run = await engine.startWorkflow({
      definitionKey: "autonomy_test",
      projectId,
      idempotencyKey: "autonomy-1",
    });
    await drain();

    const nodeRuns = await store.listNodeRuns(run.id);
    const node = nodeRuns.find((n) => n.nodeKey === "a")!;
    // The handler ran and returned success; the ENGINE downgraded it.
    expect(calls.some((c) => c.node === "a")).toBe(true);
    expect(node.state).toBe("awaiting_approval");
    expect((await store.getRun(run.id))?.state).toBe("waiting_for_approval");
  });

  it("a per-client autonomy policy overrides the shipped default", async () => {
    const graph: WorkflowDefinition = {
      key: "policy_test",
      name: "Policy test",
      description: "",
      actionType: "benchmark_execution",
      autonomyLevel: 4,
      version: 1,
      nodes: [
        { key: "a", type: "deterministic_task", name: "A", handler: "test.a" },
        { key: "done", type: "terminal_success", name: "Done" },
      ],
      edges: [{ from: "a", to: "done" }],
    };
    await engine.registerDefinition(graph);
    const cautious = await newProject("Cautious client");
    const normal = await newProject("Normal client");

    await sql`
      insert into autonomy_policies (project_id, action_type, autonomy_level, reason)
      values (${cautious}, 'benchmark_execution', 2, 'client requires sign-off on every measurement')
    `;

    const cautiousRun = await engine.startWorkflow({
      definitionKey: "policy_test",
      projectId: cautious,
      idempotencyKey: "policy-cautious",
    });
    const normalRun = await engine.startWorkflow({
      definitionKey: "policy_test",
      projectId: normal,
      idempotencyKey: "policy-normal",
    });
    await drain();

    expect((await store.getRun(cautiousRun.id))?.state).toBe("waiting_for_approval");
    expect((await store.getRun(normalRun.id))?.state).toBe("completed");
  });

  it("skips a level-0 action and asks a human to do it", async () => {
    const graph: WorkflowDefinition = {
      key: "manual_test",
      name: "Manual test",
      description: "",
      actionType: "legal_decision",
      autonomyLevel: 0,
      version: 1,
      nodes: [
        {
          key: "a",
          type: "deterministic_task",
          name: "Legal call",
          handler: "test.a",
          config: { actionType: "legal_decision" },
        },
        { key: "done", type: "terminal_success", name: "Done" },
      ],
      edges: [{ from: "a", to: "done" }],
    };
    await engine.registerDefinition(graph);
    const projectId = await newProject("Manual");
    const run = await engine.startWorkflow({
      definitionKey: "manual_test",
      projectId,
      idempotencyKey: "manual-1",
    });
    await drain();

    const nodeRuns = await store.listNodeRuns(run.id);
    expect(nodeRuns.find((n) => n.nodeKey === "a")?.state).toBe("skipped");
    const [exception] = await sql`
      select summary from workflow_exceptions where workflow_run_id = ${run.id}
    `;
    expect(exception!.summary).toContain("manual-only");
  });

  // ------------------------------------------------------- cost & cancel

  it("stops safely when the cost cap is reached, before spending more", async () => {
    behaviour.a = () => ({ outcome: "succeeded", output: { ok: true }, costMicroUsd: 5_000_000 });
    await engine.registerDefinition({ ...fanGraph(), key: "cost_test" });
    const projectId = await newProject("Cost");
    const run = await engine.startWorkflow({
      definitionKey: "cost_test",
      projectId,
      idempotencyKey: "cost-1",
      costCapMicroUsd: 1_000_000,
    });
    await drain();

    const final = await store.getRun(run.id);
    expect(final?.state).toBe("safely_stopped");
    expect(final?.stopReason).toContain("cost cap");
    // The cap stopped the NEXT node — split never ran.
    expect(calls.some((c) => c.node === "split")).toBe(false);

    const [exception] = await sql`
      select kind from workflow_exceptions where workflow_run_id = ${run.id}
    `;
    expect(exception!.kind).toBe("cost_anomaly");
  });

  it("cancels a live run without rewriting what already succeeded", async () => {
    await engine.registerDefinition(approvalGraph());
    const projectId = await newProject("Cancel");
    const run = await engine.startWorkflow({
      definitionKey: "approval_test",
      projectId,
      idempotencyKey: "cancel-1",
    });
    await drain();

    await engine.cancelWorkflow(run.id, "client paused the engagement", OPERATOR);
    const final = await store.getRun(run.id);
    expect(final?.state).toBe("cancelled");

    const nodeRuns = await store.listNodeRuns(run.id);
    expect(nodeRuns.find((n) => n.nodeKey === "a")?.state).toBe("succeeded");
    expect(nodeRuns.find((n) => n.nodeKey === "approval")?.state).toBe("cancelled");

    await expect(engine.cancelWorkflow(run.id, "again")).rejects.toThrow(/already cancelled/);
  });

  it("re-arms a terminally failed node on retry", async () => {
    // Count invocations, not attempts: a manual retry resets the attempt
    // counter, which is exactly the behaviour under test.
    let invocations = 0;
    behaviour.gate = () => {
      invocations += 1;
      return invocations === 1
        ? { outcome: "failed_terminal", error: "bad input" }
        : { outcome: "succeeded", output: { ok: true } };
    };

    await engine.registerDefinition({
      ...fanGraph(),
      key: "retrynode_test",
      nodes: fanGraph().nodes.map((n) => (n.key === "gate" ? { ...n, maxAttempts: 1 } : n)),
    });
    const projectId = await newProject("Retry node");
    const run = await engine.startWorkflow({
      definitionKey: "retrynode_test",
      projectId,
      idempotencyKey: "retrynode-1",
    });
    await drain();
    expect((await store.getRun(run.id))?.state).toBe("failed");

    const nodeRuns = await store.listNodeRuns(run.id);
    const gate = nodeRuns.find((n) => n.nodeKey === "gate")!;
    await engine.retryNode(gate.id, OPERATOR);
    await drain();

    expect((await store.getRun(run.id))?.state).toBe("completed");
    const after = await store.listNodeRuns(run.id);
    expect(after.find((n) => n.nodeKey === "gate")?.state).toBe("succeeded");
    // Work upstream of the retried node did not run again.
    expect(calls.filter((c) => c.node === "work")).toHaveLength(3);
  });

  // ------------------------------------------------------ tenant isolation

  it("keeps two clients' runs, approvals, and exceptions separate", async () => {
    await engine.registerDefinition(approvalGraph());
    const alpha = await newProject("Alpha");
    const beta = await newProject("Beta");

    const alphaRun = await engine.startWorkflow({
      definitionKey: "approval_test",
      projectId: alpha,
      idempotencyKey: "alpha-1",
    });
    const betaRun = await engine.startWorkflow({
      definitionKey: "approval_test",
      projectId: beta,
      idempotencyKey: "beta-1",
    });
    await drain();

    const alphaApprovals = await sql`
      select id from workflow_approvals where project_id = ${alpha}
    `;
    const betaApprovals = await sql`
      select id from workflow_approvals where project_id = ${beta}
    `;
    expect(alphaApprovals).toHaveLength(1);
    expect(betaApprovals).toHaveLength(1);
    expect(alphaApprovals[0]!.id).not.toBe(betaApprovals[0]!.id);

    // A project-scoped queue read never returns the other client's work.
    const { actionRequiredQueue } = await import("@/lib/control-tower/queue");
    const scoped = await actionRequiredQueue({ projectId: alpha });
    expect(scoped.length).toBeGreaterThan(0);
    expect(scoped.every((item) => item.projectId === alpha)).toBe(true);

    const both = await actionRequiredQueue({});
    expect(both.some((i) => i.projectId === alpha)).toBe(true);
    expect(both.some((i) => i.projectId === beta)).toBe(true);

    expect(alphaRun.projectId).toBe(alpha);
    expect(betaRun.projectId).toBe(beta);
  });

  it("refuses to start a workflow that was never published", async () => {
    await expect(
      engine.startWorkflow({ definitionKey: "does_not_exist", idempotencyKey: "ghost-1" })
    ).rejects.toThrow(/No published version/);
  });
});
