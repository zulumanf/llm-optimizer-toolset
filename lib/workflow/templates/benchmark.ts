/**
 * `benchmark_v1` — the measurement workflow (spec 018 Part 27 #1).
 *
 * Deliberate reuse note: capture is NOT re-implemented as graph nodes. The run
 * executor (`lib/runs/execute.ts`) already fans out over prompt × provider ×
 * repetition with its own concurrency, budget cap, cancellation, and a partial
 * unique index guaranteeing idempotency. Turning that into nodes would be
 * duplicate business logic, which CLAUDE.md forbids and which would put the
 * proven capture path at risk for no gain.
 *
 * What the graph adds is the half that never existed: a genuine fan-out over
 * providers for per-provider evidence assessment, a fan-in that DISCLOSES
 * partial results, and an evidence-completeness gate that must pass before the
 * measurement is allowed to become a client-facing number.
 */
import { sql } from "@/db/client";
import { startRun } from "@/lib/runs/service";
import { getSubjectCompany } from "@/db/companies";
import { evidenceCompletenessGate } from "@/lib/workflow/gates";
import { registerHandlers } from "@/lib/workflow/handlers";
import { CONFIDENCE_REVIEW_THRESHOLD } from "@/lib/constants";
import type { NodeResult, WorkflowDefinition } from "@/lib/workflow/types";
import type { ProviderConfig } from "@/lib/runs/cells";

export const BENCHMARK_WORKFLOW_KEY = "benchmark_v1";

/** Minimum successful captures before a benchmark may be scored (docs/06). */
export const MIN_BENCHMARK_SAMPLE = 5;

export const benchmarkWorkflow: WorkflowDefinition = {
  key: BENCHMARK_WORKFLOW_KEY,
  name: "Benchmark measurement",
  description:
    "Run a frozen benchmark, assess evidence per provider, and gate the result on completeness before it becomes a number anyone acts on.",
  actionType: "benchmark_execution",
  autonomyLevel: 4,
  version: 1,
  acceptanceCriteria: [
    "A missing subject company or unfrozen prompt set stops the run safely rather than measuring the wrong thing.",
    "Per-provider evidence is assessed independently and in parallel.",
    "A partial capture is disclosed, never silently averaged away.",
    "The evidence gate blocks scoring when the sample is too small or classifications are missing.",
  ],
  nodes: [
    {
      key: "validate_baseline",
      type: "deterministic_task",
      name: "Validate baseline configuration",
      handler: "benchmark.validate_baseline",
      description: "Subject company, frozen prompt set version, and provider config must all exist.",
      failureStrategy: "safe_stop",
      timeoutSeconds: 60,
    },
    {
      key: "start_capture",
      type: "integration_task",
      name: "Start capture",
      handler: "benchmark.start_capture",
      description: "Hands off to the proven run executor; records the run id.",
      timeoutSeconds: 120,
      maxAttempts: 2,
      failureStrategy: "safe_stop",
    },
    {
      key: "await_capture",
      type: "integration_task",
      name: "Await capture",
      handler: "benchmark.await_capture",
      description: "Polls the run until it settles. Retryable by design — waiting is not failing.",
      timeoutSeconds: 60,
      maxAttempts: 60,
      retryBackoffSeconds: 30,
      failureStrategy: "safe_stop",
    },
    {
      key: "fan_providers",
      type: "fan_out",
      name: "Fan out by provider",
      handler: "benchmark.fan_providers",
      description: "One evidence assessment per provider; they do not depend on each other.",
    },
    {
      key: "provider_evidence",
      type: "deterministic_task",
      name: "Assess provider evidence",
      handler: "benchmark.provider_evidence",
      description: "Captures, classifications, low-confidence routing, and hashes for one provider.",
      timeoutSeconds: 120,
      failureStrategy: "continue",
    },
    {
      key: "join_providers",
      type: "fan_in",
      name: "Join provider assessments",
      config: { minimumBranches: 1 },
      description: "Waits for every provider branch and discloses any that failed.",
    },
    {
      key: "evidence_gate",
      type: "evidence_gate",
      name: "Evidence completeness gate",
      handler: "benchmark.evidence_gate",
      description: "Sample size, raw evidence, classifications, low-confidence routing, disclosure.",
      riskLevel: "medium",
      failureStrategy: "safe_stop",
    },
    { key: "done", type: "terminal_success", name: "Benchmark complete" },
    { key: "blocked", type: "terminal_failure", name: "Benchmark blocked" },
  ],
  edges: [
    { from: "validate_baseline", to: "start_capture" },
    { from: "start_capture", to: "await_capture" },
    { from: "await_capture", to: "fan_providers" },
    { from: "fan_providers", to: "provider_evidence" },
    { from: "provider_evidence", to: "join_providers" },
    { from: "join_providers", to: "evidence_gate" },
    {
      from: "evidence_gate",
      to: "done",
      condition: { kind: "output_equals", path: "outcome", value: "pass" },
    },
    {
      from: "evidence_gate",
      to: "blocked",
      condition: { kind: "output_equals", path: "outcome", value: "fail" },
      required: false,
    },
  ],
};

// ------------------------------------------------------------- handlers

registerHandlers({
  "benchmark.validate_baseline": async (ctx): Promise<NodeResult> => {
    const projectId = ctx.projectId;
    if (!projectId) {
      return { outcome: "safe_stop", reason: "benchmark_v1 requires a project (client) scope" };
    }
    const subject = await getSubjectCompany(projectId);
    if (!subject) {
      return {
        outcome: "safe_stop",
        reason: "no subject company configured — the benchmark would measure nobody",
      };
    }
    const [project] = await sql`
      select baseline_prompt_set_id, baseline_config from projects where id = ${projectId}
    `;
    if (!project?.baselinePromptSetId) {
      return { outcome: "safe_stop", reason: "no baseline prompt set configured" };
    }
    const [version] = await sql`
      select id, version from prompt_set_versions
      where prompt_set_id = ${project.baselinePromptSetId}
      order by version desc limit 1
    `;
    if (!version) {
      return { outcome: "safe_stop", reason: "the baseline prompt set has never been frozen" };
    }
    const config = project.baselineConfig as
      | { providers: ProviderConfig[]; budgetUsd: number }
      | null;
    if (!config?.providers?.length || !config.budgetUsd) {
      return { outcome: "safe_stop", reason: "baseline configuration is incomplete" };
    }
    return {
      outcome: "succeeded",
      output: {
        promptSetVersionId: version.id as string,
        promptSetVersion: Number(version.version),
        subjectCompanyId: subject.id,
        providers: config.providers.map((p) => p.provider),
        budgetUsd: config.budgetUsd,
      },
    };
  },

  "benchmark.start_capture": async (ctx): Promise<NodeResult> => {
    const upstream = ctx.inputs.validate_baseline as {
      promptSetVersionId: string;
      budgetUsd: number;
    };
    const projectId = ctx.projectId!;
    const [project] = await sql`
      select baseline_config from projects where id = ${projectId}
    `;
    const config = project?.baselineConfig as { providers: ProviderConfig[] } | null;

    // Reuse an existing run for this workflow if one is already attached —
    // a retried node must not start a second benchmark.
    const label = `Workflow benchmark ${ctx.runId.slice(0, 8)}`;
    const [existing] = await sql`
      select id from runs where project_id = ${projectId} and label = ${label} limit 1
    `;
    if (existing) {
      return { outcome: "succeeded", output: { runId: existing.id as string, reused: true } };
    }

    const started = await startRun(
      null,
      {
        projectId,
        promptSetVersionId: upstream.promptSetVersionId,
        providers: config?.providers ?? [],
        budgetUsd: upstream.budgetUsd,
        label,
      },
      "scheduled"
    );
    if (!started.ok) {
      return { outcome: "failed_retryable", error: started.error.message };
    }
    return { outcome: "succeeded", output: { runId: started.data.id, reused: false } };
  },

  "benchmark.await_capture": async (ctx): Promise<NodeResult> => {
    const runId = (ctx.inputs.start_capture as { runId: string }).runId;
    const [run] = await sql`select status, status_detail from runs where id = ${runId}`;
    const status = run?.status as string | undefined;

    if (status === "pending" || status === "running") {
      // Not a failure — a wait. The engine's retry backoff is the poll.
      return { outcome: "failed_retryable", error: `capture is ${status}` };
    }
    if (status === "failed") {
      return {
        outcome: "safe_stop",
        reason: `capture failed: ${(run?.statusDetail as string) ?? "all cells failed"}`,
      };
    }
    const [counts] = await sql`
      select
        count(*) filter (where error is null) as captured,
        count(*) filter (where error is not null) as failed
      from responses where run_id = ${runId}
    `;
    return {
      outcome: "succeeded",
      output: {
        runId,
        status,
        partial: status === "partial",
        statusDetail: (run?.statusDetail as string) ?? null,
        captured: Number(counts?.captured ?? 0),
        failedCells: Number(counts?.failed ?? 0),
      },
    };
  },

  "benchmark.fan_providers": async (ctx): Promise<NodeResult> => {
    const runId = (ctx.inputs.await_capture as { runId: string }).runId;
    const rows = await sql`
      select distinct provider from responses where run_id = ${runId} order by provider
    `;
    const providers = rows.map((r) => r.provider as string);
    if (providers.length === 0) {
      return { outcome: "safe_stop", reason: "no captures exist to assess" };
    }
    return { outcome: "succeeded", output: { runId, providers }, fanKeys: providers };
  },

  "benchmark.provider_evidence": async (ctx): Promise<NodeResult> => {
    const runId = (ctx.inputs.await_capture as { runId: string } | undefined)?.runId
      ?? (ctx.inputs.fan_providers as { runId: string }).runId;
    const provider = ctx.fanKey;

    const [row] = await sql`
      select
        count(*) filter (where r.error is null) as captured,
        count(*) filter (where r.error is not null) as failed,
        count(*) filter (where r.response_hash is not null and r.error is null) as hashed,
        count(distinct p.response_id) as parsed
      from responses r
      left join response_parses p on p.response_id = r.id
      where r.run_id = ${runId} and r.provider = ${provider}
    `;
    const [confidence] = await sql`
      select
        count(*) filter (where m.confidence < ${CONFIDENCE_REVIEW_THRESHOLD}) as low_confidence,
        count(*) filter (where m.confidence < ${CONFIDENCE_REVIEW_THRESHOLD} and m.needs_review) as routed
      from mentions m
      join responses r on r.id = m.response_id
      where r.run_id = ${runId} and r.provider = ${provider}
    `;

    const captured = Number(row?.captured ?? 0);
    const hashed = Number(row?.hashed ?? 0);
    return {
      outcome: "succeeded",
      output: {
        ok: captured > 0,
        provider,
        captured,
        failed: Number(row?.failed ?? 0),
        parsed: Number(row?.parsed ?? 0),
        hashesValid: captured === 0 ? null : hashed === captured,
        lowConfidence: Number(confidence?.lowConfidence ?? 0),
        lowConfidenceRouted: Number(confidence?.routed ?? 0),
      },
    };
  },

  "benchmark.evidence_gate": async (ctx): Promise<NodeResult> => {
    const join = ctx.inputs.join_providers as {
      completed: number;
      failed: number;
      total: number;
      partial: boolean;
      partialDisclosed: boolean;
    };
    // The fan-in preserved each branch's disclosure; re-read the branch
    // outputs so the gate judges data, not a summary of data.
    const branchRows = await sql`
      select output from node_runs
      where workflow_run_id = ${ctx.runId} and node_key = 'provider_evidence'
        and state = 'succeeded'
    `;
    const branches = branchRows.map(
      (r) =>
        r.output as {
          captured: number;
          failed: number;
          parsed: number;
          hashesValid: boolean | null;
          lowConfidence: number;
          lowConfidenceRouted: number;
        }
    );

    const sum = (pick: (b: (typeof branches)[number]) => number): number =>
      branches.reduce((total, b) => total + (pick(b) || 0), 0);
    const captured = sum((b) => b.captured);
    const anyUnverified = branches.some((b) => b.hashesValid === null);

    const result = evidenceCompletenessGate({
      requiredUpstreamTotal: join.total,
      requiredUpstreamCompleted: join.completed,
      sampleSize: captured,
      minimumSampleSize: MIN_BENCHMARK_SAMPLE,
      rawEvidenceCount: captured,
      requiredArtifactKinds: [],
      presentArtifactKinds: [],
      hashesValid: anyUnverified ? null : branches.every((b) => b.hashesValid === true),
      classifiedCount: sum((b) => b.parsed),
      lowConfidenceCount: sum((b) => b.lowConfidence),
      lowConfidenceRoutedCount: sum((b) => b.lowConfidenceRouted),
      partialFailureCount: sum((b) => b.failed) + join.failed,
      partialFailureDisclosed: join.partialDisclosed,
    });

    // `insufficient_evidence` is a safe stop, not a failure — the difference
    // between "this is wrong" and "I cannot tell" matters to the operator.
    if (result.outcome === "insufficient_evidence") {
      return {
        outcome: "safe_stop",
        reason: `evidence gate could not be evaluated: ${result.reason}`,
        output: { outcome: result.outcome, checks: result.checks },
      };
    }
    return {
      outcome: "succeeded",
      output: {
        outcome: result.outcome,
        reason: result.reason,
        checks: result.checks,
        gateVersion: result.gateVersion,
        sampleSize: captured,
      },
    };
  },
});
