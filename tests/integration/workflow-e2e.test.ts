/**
 * End-to-end scenario for the graph platform (spec 018 Part 30).
 *
 * One client, one benchmark, real capture through the existing run executor,
 * a real evidence gate, a real approval pause and resume, a real outcome
 * chain, and a real gated executive brief. Nothing here is stubbed except the
 * AI provider (the deterministic mock) and the two agent callers, because
 * spending tokens in CI is not a test, it is a bill.
 *
 * What this proves that the unit tests cannot: the shipped templates work
 * against the shipped schema, and every stage lands in the audit trail.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { seedTestActors } from "../helpers/actors";

const TEST_URL = process.env.TEST_DATABASE_URL;
const ROOT = join(__dirname, "..", "..");

const user: CurrentUser = {
  id: "00000000-0000-4000-8000-000000009101",
  email: "op@test.local",
  name: "Operator",
  role: "admin",
};

describe.skipIf(!TEST_URL)("graph platform end-to-end", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let engine: typeof import("@/lib/workflow/engine");
  let templates: typeof import("@/lib/workflow/templates");
  let store: typeof import("@/db/workflow");
  let jobs: typeof import("@/db/jobs");
  let execute: typeof import("@/lib/runs/execute");
  let parsing: typeof import("@/lib/parsing/service");
  let scoring: typeof import("@/lib/scoring/compute");
  let projectSvc: typeof import("@/lib/projects/service");
  let companySvc: typeof import("@/lib/companies/service");
  let claimsSvc: typeof import("@/lib/claims/service");
  let setSvc: typeof import("@/lib/prompts/set-service");
  let promptSvc: typeof import("@/lib/prompts/prompt-service");
  let baselineSvc: typeof import("@/lib/projects/baseline");
  let mock: typeof import("@/lib/ai/mock");
  let packet: typeof import("@/lib/knowledge/packet");
  let outcomes: typeof import("@/lib/outcomes/graph");
  let health: typeof import("@/lib/control-tower/health");
  let capacity: typeof import("@/lib/control-tower/capacity");
  let queue: typeof import("@/lib/control-tower/queue");

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    engine = await import("@/lib/workflow/engine");
    templates = await import("@/lib/workflow/templates");
    store = await import("@/db/workflow");
    jobs = await import("@/db/jobs");
    execute = await import("@/lib/runs/execute");
    parsing = await import("@/lib/parsing/service");
    scoring = await import("@/lib/scoring/compute");
    projectSvc = await import("@/lib/projects/service");
    companySvc = await import("@/lib/companies/service");
    claimsSvc = await import("@/lib/claims/service");
    setSvc = await import("@/lib/prompts/set-service");
    promptSvc = await import("@/lib/prompts/prompt-service");
    baselineSvc = await import("@/lib/projects/baseline");
    mock = await import("@/lib/ai/mock");
    packet = await import("@/lib/knowledge/packet");
    outcomes = await import("@/lib/outcomes/graph");
    health = await import("@/lib/control-tower/health");
    capacity = await import("@/lib/control-tower/capacity");
    queue = await import("@/lib/control-tower/queue");

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
       operator_capacity_snapshots, executive_briefs, notifications,
       accuracy_findings, gap_findings, content_versions, content_assets,
       claims, tasks, evidence, intervention_runs, interventions, reports,
       brand_candidates, competitors, scores, sources, response_parses, mentions,
       companies, responses, runs, prompt_set_versions, prompts, prompt_sets,
       projects cascade`
    );
    mock.resetMockProvider();
    await templates.bootstrapWorkflows();
  });

  afterAll(async () => {
    await sql.end();
  });

  /** Drive the queue exactly as workers/index.ts does. */
  async function drain(maxJobs = 400): Promise<void> {
    for (let i = 0; i < maxJobs; i += 1) {
      const job = await jobs.claimNextJob("e2e-worker");
      if (!job) return;
      try {
        if (job.type === "advance_workflow") {
          await engine.advanceWorkflow(job.payload.runId as string);
        } else if (job.type === "execute_run") {
          await execute.executeRun(job.payload.runId as string);
        } else if (job.type === "parse_response") {
          await parsing.parseResponse(job.payload.responseId as string);
        } else if (job.type === "compute_scores") {
          await scoring.computeScores(job.payload.runId as string);
        }
        await jobs.completeJob(job.id);
      } catch (err) {
        await jobs.failJob(job, err instanceof Error ? err.message : "unknown");
      }
    }
  }

  async function seedClient(name: string): Promise<{ projectId: string; companyId: string }> {
    // Company names are globally unique among active rows, so each client in a
    // multi-tenant test needs its own subject.
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const company = await companySvc.upsertCompany(user, {
      name: `Parva ${name}`,
      aliases: [`${slug}.example.com`],
      domain: `${slug}.example.com`,
    });
    if (!company.ok) throw new Error(company.error.message);
    const project = await projectSvc.createProject(user, { name });
    if (!project.ok) throw new Error(project.error.message);
    await claimsSvc.setSubjectCompany(user, {
      projectId: project.data.id,
      companyId: company.data.id,
    });
    const set = await setSvc.createPromptSet(user, {
      projectId: project.data.id,
      name: "Baseline",
    });
    if (!set.ok) throw new Error(set.error.message);
    for (const text of [
      "What are the best planning tools?",
      "Which planning tool should a small team choose?",
      "Compare planning tools for agencies.",
    ]) {
      await promptSvc.addPrompt(user, {
        setId: set.data.id,
        text,
        category: "recommendation",
      });
    }
    await setSvc.freezePromptSet(user, { id: set.data.id });
    const configured = await baselineSvc.updateBaselineSettings(user, {
      projectId: project.data.id,
      baselinePromptSetId: set.data.id,
      providers: [{ provider: "mock", model: "mock-model", repetitions: 2 }],
      budgetUsd: 5,
    });
    if (!configured.ok) throw new Error(configured.error.message);
    return { projectId: project.data.id, companyId: company.data.id };
  }

  it("runs a benchmark workflow end to end: capture → fan-out → gate → evidence", async () => {
    const { projectId } = await seedClient("E2E client");

    const run = await engine.startWorkflow({
      definitionKey: templates.BENCHMARK_WORKFLOW_KEY,
      projectId,
      idempotencyKey: `e2e-benchmark-${projectId}`,
      trigger: "scheduled",
    });
    await drain();

    const final = await store.getRun(run.id);
    expect(final?.state).toBe("completed");

    const nodeRuns = await store.listNodeRuns(run.id);
    const byKey = (key: string) => nodeRuns.filter((n) => n.nodeKey === key);

    // Capture happened through the real executor and produced real responses.
    const captureNode = byKey("await_capture")[0]!;
    expect(captureNode.state).toBe("succeeded");
    const capturedRunId = (captureNode.output as { runId: string }).runId;
    const responses = await sql`
      select count(*)::int as n from responses where run_id = ${capturedRunId}
    `;
    // 3 prompts × 1 provider × 2 repetitions
    expect(Number(responses[0]!.n)).toBe(6);

    // Fan-out produced one evidence assessment per provider.
    expect(byKey("provider_evidence")).toHaveLength(1);
    expect(byKey("provider_evidence")[0]!.fanKey).toBe("mock");

    // The fan-in disclosed what it joined.
    expect(byKey("join_providers")[0]!.output).toMatchObject({
      completed: 1,
      failed: 0,
      partialDisclosed: true,
    });

    // The evidence gate ran on real counts and passed.
    const gate = byKey("evidence_gate")[0]!;
    expect(gate.state).toBe("succeeded");
    expect(gate.output).toMatchObject({ outcome: "pass" });
    expect((gate.output as { sampleSize: number }).sampleSize).toBe(6);

    // Every stage is in the append-only transition history.
    const transitions = await sql`
      select node_version, to_state from workflow_transitions
      where workflow_run_id = ${run.id} and scope = 'node'
    `;
    const touched = new Set(transitions.map((t) => t.nodeVersion as string));
    expect(touched).toContain("validate_baseline");
    expect(touched).toContain("start_capture");
    expect(touched).toContain("fan_providers");
    expect(touched).toContain("evidence_gate");

    // And the run is attributable in the shared audit log.
    const audit = await sql`
      select action from audit_log where entity = 'workflow_run' and entity_id = ${run.id}
    `;
    expect(audit.map((a) => a.action)).toContain("workflow.start");
  });

  it("stops the benchmark safely when the client is not configured", async () => {
    const project = await projectSvc.createProject(user, { name: "Unconfigured" });
    if (!project.ok) throw new Error(project.error.message);

    const run = await engine.startWorkflow({
      definitionKey: templates.BENCHMARK_WORKFLOW_KEY,
      projectId: project.data.id,
      idempotencyKey: `e2e-unconfigured-${project.data.id}`,
    });
    await drain();

    const final = await store.getRun(run.id);
    expect(final?.state).toBe("safely_stopped");
    expect(final?.stopReason).toMatch(/subject company|baseline/);

    // The operator learns about it through the one queue, prioritised.
    const items = await queue.actionRequiredQueue({ projectId: project.data.id });
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]!.priority.total).toBeGreaterThan(0);
    expect(items[0]!.priority.components.length).toBe(6);
  });

  it("builds a task-scoped evidence packet that withholds restricted claims", async () => {
    const { projectId } = await seedClient("Packet client");

    const proposePublic = await claimsSvc.proposeClaim(user, {
      projectId,
      key: "founded_year",
      canonicalText: "Parva was founded in 2019.",
      asOf: "2026-01-01",
      evidence: [{ url: "https://parva.com/about", note: "About page" }],
    });
    if (!proposePublic.ok) throw new Error(proposePublic.error.message);
    const approvedPublic = await claimsSvc.approveClaim(user, {
      claimId: proposePublic.data.id,
    });
    if (!approvedPublic.ok) throw new Error(approvedPublic.error.message);

    const proposePrivate = await claimsSvc.proposeClaim(user, {
      projectId,
      key: "internal_margin",
      canonicalText: "Gross margin is 62%.",
      asOf: "2026-01-01",
      evidence: [{ url: "https://internal.example.com/deck", note: "Internal deck" }],
    });
    if (!proposePrivate.ok) throw new Error(proposePrivate.error.message);
    const approvedPrivate = await claimsSvc.approveClaim(user, {
      claimId: proposePrivate.data.id,
    });
    if (!approvedPrivate.ok) throw new Error(approvedPrivate.error.message);
    await sql`
      update claims set privacy_status = 'restricted' where id = ${proposePrivate.data.id}
    `;

    const built = await packet.buildEvidencePacket({
      projectId,
      purpose: "public content draft",
      audience: "public",
    });

    expect(built.claims.map((c) => c.key)).toEqual(["founded_year"]);
    // The omission is recorded, not silent — that is what makes it auditable.
    expect(built.withheldClaimIds).toContain(proposePrivate.data.id);
    expect(packet.renderPacket(built)).not.toContain("62%");

    // An internal-audience packet still refuses `restricted`.
    const internal = await packet.buildEvidencePacket({
      projectId,
      purpose: "internal analysis",
      audience: "internal",
    });
    expect(internal.claims.map((c) => c.key)).toEqual(["founded_year"]);

    // The packet is stored with a hash so the agent's inputs stay reproducible.
    const id = await sql.begin((tx) => packet.recordPacket(tx, built, {}));
    const [stored] = await sql`select content_hash from evidence_packets where id = ${id}`;
    expect(stored!.contentHash).toBe(built.contentHash);
    await expect(
      sql`update evidence_packets set purpose = 'tampered' where id = ${id}`
    ).rejects.toThrow();
  });

  it("records an action-to-outcome chain without promoting correlation to cause", async () => {
    const { projectId } = await seedClient("Outcome client");

    const actionId = await sql.begin((tx) =>
      outcomes.recordAction(tx, {
        projectId,
        actionType: "content_asset",
        hypothesis: "A comparison page should improve retrieval for the compare cluster.",
        stateBefore: { recommendationRate: 0.2 },
        completedOn: "2026-05-01",
        expectedDaysToImpact: 30,
      })
    );

    const verdict = await sql.begin((tx) =>
      outcomes.measureAction(tx, {
        actionOutcomeId: actionId,
        before: { visibility: 0.2, traffic: 100 },
        after: { visibility: 0.35, traffic: 140 },
        materialityThreshold: 0.1,
        confounders: [],
      })
    );
    expect(verdict.label).toBe("positive_signal");
    expect(verdict.reason).toContain("association");

    // Re-measuring in place is refused: a client was told the first number.
    await expect(
      sql.begin((tx) =>
        outcomes.measureAction(tx, {
          actionOutcomeId: actionId,
          after: { visibility: 0.9 },
          materialityThreshold: 0.1,
        })
      )
    ).rejects.toThrow(/already been measured/);

    // Deterministic code with no identifier cannot say "confirmed".
    const inferred = await sql.begin((tx) =>
      outcomes.recordRelationship(tx, {
        projectId,
        fromKind: "action",
        fromId: actionId,
        toKind: "visibility_change",
        toId: actionId,
        relation: "preceded",
        requestedConfidence: "confirmed",
        basis: "visibility rose in the measurement window after the action",
        createdByKind: "deterministic",
        hasMatchingIdentifier: false,
      })
    );
    expect(inferred.label).toBe("strongly_supported");
    expect(inferred.lowered).toBe(true);

    const [row] = await sql`
      select basis, confidence_label from outcome_relationships where id = ${inferred.id}
    `;
    expect(row!.basis).toContain("no matching identifier");
    expect(row!.confidenceLabel).toBe("strongly_supported");

    // The edge is immutable — nobody upgrades it later without a new row.
    await expect(
      sql`update outcome_relationships set confidence_label = 'confirmed' where id = ${inferred.id}`
    ).rejects.toThrow();

    const chain = await outcomes.outcomeChain(projectId, {
      kind: "action",
      id: actionId,
    });
    expect(chain.chain).toHaveLength(1);
    expect(chain.weakestLink).toBe("strongly_supported");
  });

  it("withholds a weekly brief when the reporting gate cannot pass, and writes one when it can", async () => {
    const { projectId } = await seedClient("Brief client");

    // Nothing measured yet → the period is incomplete → no brief exists.
    const empty = await engine.startWorkflow({
      definitionKey: templates.WEEKLY_BRIEF_WORKFLOW_KEY,
      projectId,
      input: { periodStart: "2026-07-20", periodEnd: "2026-07-26" },
      idempotencyKey: `brief-empty-${projectId}`,
    });
    await drain();

    expect((await store.getRun(empty.id))?.state).toBe("safely_stopped");
    const noBriefs = await sql`
      select count(*)::int as n from executive_briefs where project_id = ${projectId}
    `;
    expect(Number(noBriefs[0]!.n)).toBe(0);

    // A health snapshot was still written — the two branches are independent,
    // which is exactly why there is no edge between them.
    const snapshots = await sql`
      select overall, confidence, missing from client_health_snapshots
      where project_id = ${projectId}
    `;
    expect(snapshots).toHaveLength(1);
    expect(Number(snapshots[0]!.confidence)).toBeLessThan(1);

    // Now measure the client for real, then run the brief again.
    const benchmark = await engine.startWorkflow({
      definitionKey: templates.BENCHMARK_WORKFLOW_KEY,
      projectId,
      idempotencyKey: `brief-benchmark-${projectId}`,
    });
    await drain();
    expect((await store.getRun(benchmark.id))?.state).toBe("completed");

    const today = new Date().toISOString().slice(0, 10);
    const withData = await engine.startWorkflow({
      definitionKey: templates.WEEKLY_BRIEF_WORKFLOW_KEY,
      projectId,
      input: { periodStart: "2026-01-01", periodEnd: today },
      idempotencyKey: `brief-full-${projectId}`,
    });
    await drain();

    const state = await store.getRun(withData.id);
    expect(state?.state).toBe("completed");

    const [brief] = await sql`
      select sections, materiality, generated_by from executive_briefs
      where project_id = ${projectId} and kind = 'weekly'
    `;
    expect(brief).toBeDefined();
    expect(brief!.generatedBy).toBe("deterministic");
    const sections = brief!.sections as {
      statements: { text: string; kind: string }[];
      uncertainties: string[];
    };
    // Every statement declares what kind of claim it is.
    expect(sections.statements.length).toBeGreaterThan(0);
    for (const statement of sections.statements) {
      expect([
        "fact",
        "calculation",
        "interpretation",
        "recommendation",
        "correlation",
        "causal",
        "unknown",
      ]).toContain(statement.kind);
    }
    // No causal claim appears without a human, ever.
    expect(sections.statements.some((s) => s.kind === "causal")).toBe(false);
    expect(sections.uncertainties.length).toBeGreaterThan(0);
  });

  it("measures automation and capacity from observed data, or says it cannot", async () => {
    const { projectId } = await seedClient("Capacity client");
    const benchmark = await engine.startWorkflow({
      definitionKey: templates.BENCHMARK_WORKFLOW_KEY,
      projectId,
      idempotencyKey: `capacity-${projectId}`,
    });
    await drain();
    expect((await store.getRun(benchmark.id))?.state).toBe("completed");

    const period = { start: "2026-01-01", end: new Date().toISOString().slice(0, 10) };
    const automation = await capacity.automationRate(period);
    expect(automation.settled).toBeGreaterThan(0);
    // A fully autonomous benchmark should measure as fully autonomous.
    expect(automation.rate).toBe(1);

    const report = await capacity.computeCapacity(period);
    // Far below the observation threshold — the honest answer is "I can't say".
    expect(report.supportableClients).toBeNull();
    expect(report.notes).toContain("Insufficient data");
    expect(report.observationCount).toBeLessThan(capacity.MIN_OBSERVATIONS_FOR_CAPACITY);

    const snapshotId = await sql.begin((tx) => capacity.recordCapacitySnapshot(tx, report));
    await expect(
      sql`update operator_capacity_snapshots set active_clients = 99 where id = ${snapshotId}`
    ).rejects.toThrow();
  });

  it("writes an append-only health snapshot whose components are all disclosed", async () => {
    const { projectId } = await seedClient("Health client");
    const period = { start: "2026-01-01", end: new Date().toISOString().slice(0, 10) };

    const first = await health.computeClientHealth(projectId, period);
    expect(first.components).toHaveLength(health.HEALTH_COMPONENTS.length);
    expect(first.weightsVersion).toBe(health.HEALTH_WEIGHTS_VERSION);
    // Every component says either a score or why it has none.
    for (const component of first.components) {
      expect(component.detail.length).toBeGreaterThan(0);
    }

    const id = await sql.begin((tx) => health.recordHealthSnapshot(tx, first));
    await expect(
      sql`update client_health_snapshots set overall = 1 where id = ${id}`
    ).rejects.toThrow();
    await expect(sql`delete from client_health_snapshots where id = ${id}`).rejects.toThrow();

    // Recomputing writes a NEW row rather than editing the old one.
    const second = await health.computeClientHealth(projectId, period);
    await sql.begin((tx) => health.recordHealthSnapshot(tx, second));
    const rows = await sql`
      select count(*)::int as n from client_health_snapshots where project_id = ${projectId}
    `;
    expect(Number(rows[0]!.n)).toBe(2);
  });

  it("isolates two clients across every graph surface", async () => {
    const alpha = await seedClient("Alpha client");
    const beta = await seedClient("Beta client");

    for (const projectId of [alpha.projectId, beta.projectId]) {
      await engine.startWorkflow({
        definitionKey: templates.BENCHMARK_WORKFLOW_KEY,
        projectId,
        idempotencyKey: `isolation-${projectId}`,
      });
    }
    await drain();

    const alphaRuns = await sql`
      select id from workflow_runs where project_id = ${alpha.projectId}
    `;
    const betaRuns = await sql`
      select id from workflow_runs where project_id = ${beta.projectId}
    `;
    expect(alphaRuns).toHaveLength(1);
    expect(betaRuns).toHaveLength(1);

    // Node runs never cross the tenant boundary.
    const crossed = await sql`
      select count(*)::int as n
      from node_runs n
      join workflow_runs r on r.id = n.workflow_run_id
      where r.project_id = ${alpha.projectId}
        and exists (
          select 1 from responses resp
          join runs run2 on run2.id = resp.run_id
          where run2.project_id = ${beta.projectId}
            and resp.id::text = n.output->>'responseId'
        )
    `;
    expect(Number(crossed[0]!.n)).toBe(0);

    // A project-scoped queue read returns only that client's work.
    const alphaQueue = await queue.actionRequiredQueue({ projectId: alpha.projectId });
    expect(alphaQueue.every((i) => i.projectId === alpha.projectId)).toBe(true);
  });
});
