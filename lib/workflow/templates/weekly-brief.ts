/**
 * `weekly_brief_v1` — operational decision support (spec 018 Part 27 #9,
 * spec 019 Part 16).
 *
 * Autonomy 3: it runs by itself and records what it produced for retrospective
 * review. It does not deliver anything to a client — delivery is a separate,
 * approval-gated act.
 */
import { sql } from "@/db/client";
import { generateWeeklyBrief } from "@/lib/reports/executive";
import { computeClientHealth, recordHealthSnapshot } from "@/lib/control-tower/health";
import { registerHandlers } from "@/lib/workflow/handlers";
import { raiseException } from "@/lib/workflow/exceptions";
import type { NodeResult, WorkflowDefinition } from "@/lib/workflow/types";

export const WEEKLY_BRIEF_WORKFLOW_KEY = "weekly_brief_v1";

export const weeklyBriefWorkflow: WorkflowDefinition = {
  key: WEEKLY_BRIEF_WORKFLOW_KEY,
  name: "Weekly executive brief",
  description:
    "Compute the week's material changes and client health, compose an evidence-linked brief, and gate it before it exists as a document.",
  actionType: "weekly_reporting",
  autonomyLevel: 3,
  version: 1,
  acceptanceCriteria: [
    "Only movements above the materiality threshold are reported.",
    "Every statement carries its kind (fact / calculation / interpretation / recommendation / correlation / causal / unknown).",
    "A brief that fails the executive reporting gate is not written at all.",
    "Health and brief are computed independently and in parallel.",
  ],
  nodes: [
    {
      key: "resolve_period",
      type: "deterministic_task",
      name: "Resolve the reporting period",
      handler: "brief.resolve_period",
      failureStrategy: "safe_stop",
    },
    // Health and the brief share a period but neither needs the other's
    // output — an edge between them would be a lie about the dependency.
    {
      key: "client_health",
      type: "deterministic_task",
      name: "Compute client health",
      handler: "brief.client_health",
      failureStrategy: "continue",
      timeoutSeconds: 300,
    },
    {
      key: "compose_brief",
      type: "deterministic_task",
      name: "Compose and gate the brief",
      handler: "brief.compose",
      failureStrategy: "safe_stop",
      timeoutSeconds: 300,
      riskLevel: "medium",
    },
    {
      key: "join",
      type: "fan_in",
      name: "Join health and brief",
      config: { minimumBranches: 0 },
    },
    { key: "done", type: "terminal_success", name: "Brief ready for review" },
  ],
  edges: [
    { from: "resolve_period", to: "client_health" },
    { from: "resolve_period", to: "compose_brief" },
    { from: "client_health", to: "join", required: false },
    { from: "compose_brief", to: "join" },
    { from: "join", to: "done" },
  ],
};

registerHandlers({
  "brief.resolve_period": async (ctx): Promise<NodeResult> => {
    if (!ctx.projectId) {
      return { outcome: "safe_stop", reason: "weekly_brief_v1 requires a client scope" };
    }
    const periodStart = ctx.workflowInput.periodStart as string | undefined;
    const periodEnd = ctx.workflowInput.periodEnd as string | undefined;
    if (!periodStart || !periodEnd) {
      return {
        outcome: "safe_stop",
        reason: "periodStart and periodEnd must be supplied — the brief will not guess its own period",
      };
    }
    return { outcome: "succeeded", output: { periodStart, periodEnd } };
  },

  "brief.client_health": async (ctx): Promise<NodeResult> => {
    const period = ctx.inputs.resolve_period as { periodStart: string; periodEnd: string };
    const snapshot = await computeClientHealth(ctx.projectId!, {
      start: period.periodStart,
      end: period.periodEnd,
    });
    const id = await sql.begin((tx) => recordHealthSnapshot(tx, snapshot));
    return {
      outcome: "succeeded",
      output: {
        ok: true,
        snapshotId: id,
        overall: snapshot.overall,
        confidence: snapshot.confidence,
        missing: snapshot.missing,
      },
      confidence: snapshot.confidence,
    };
  },

  "brief.compose": async (ctx): Promise<NodeResult> => {
    const period = ctx.inputs.resolve_period as { periodStart: string; periodEnd: string };
    const result = await sql.begin((tx) =>
      generateWeeklyBrief(tx, {
        projectId: ctx.projectId!,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
      })
    );

    if (result.gate.outcome !== "pass") {
      await sql.begin((tx) =>
        raiseException(tx, {
          projectId: ctx.projectId,
          workflowRunId: ctx.runId,
          kind: "failed_workflow",
          severity: "medium",
          summary: `Weekly brief withheld: ${result.gate.reason}`,
          detail: { checks: result.gate.checks },
          recommendedAction:
            "Complete the missing measurement or evidence, then re-run the brief.",
        })
      );
      return {
        outcome: "safe_stop",
        reason: `executive reporting gate ${result.gate.outcome}: ${result.gate.reason}`,
        output: { ok: false, gate: result.gate.outcome, checks: result.gate.checks },
      };
    }

    return {
      outcome: "succeeded",
      output: {
        ok: true,
        briefId: result.briefId,
        statementCount: result.statements.length,
        materialCount: result.statements.filter((s) => s.material).length,
        gate: result.gate.outcome,
      },
    };
  },
});
