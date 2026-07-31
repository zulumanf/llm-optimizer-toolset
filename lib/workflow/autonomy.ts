/**
 * Autonomy levels (spec 018, Part 12). The level answers one question about a
 * node: *may this run without a human?*
 *
 * Enforcement is structural. `requiresApprovalFor()` is called by the engine
 * before a node settles; a node at level ≤ 2 cannot reach `succeeded` without
 * a decided approval row. No prompt, no convention.
 */
import { sql } from "@/db/client";
import type { AutonomyLevel, NodeType, RiskLevel } from "@/lib/workflow/types";

/** The highest level at which a human must approve before execution counts. */
export const APPROVAL_REQUIRED_AT_OR_BELOW: AutonomyLevel = 2;

/**
 * Shipped defaults by action type
 * (docs/architecture/automation-quality-operating-model.md). Anything not
 * listed falls back to DEFAULT_AUTONOMY — approval required, because the safe
 * default for an unrecognised action is to ask.
 */
export const DEFAULT_AUTONOMY: AutonomyLevel = 2;

export const ACTION_TYPE_AUTONOMY: Record<string, AutonomyLevel> = {
  benchmark_execution: 4,
  evidence_capture: 4,
  metric_calculation: 4,
  analytics_ingestion: 4,
  crm_ingestion: 4,
  routine_classification: 4,
  weekly_reporting: 4,
  content_opportunity_detection: 4,
  monthly_report_preparation: 3,
  revenue_attribution_inference: 3,
  content_drafting: 3,
  low_confidence_classification: 2,
  executive_recommendation: 2,
  public_profile_correction: 2,
  cms_publishing: 2,
  ranking_submission: 2,
  journalist_outreach: 2,
  material_client_claim: 2,
  privacy_sensitive_action: 2,
  legal_decision: 0,
};

export interface AutonomyResolution {
  level: AutonomyLevel;
  source: "policy" | "node" | "action_type" | "workflow" | "default";
  /** Which policy row or default produced the level — shown in the UI. */
  detail: string;
}

/**
 * Resolve the effective autonomy for one node execution.
 *
 * Precedence, most specific first:
 *   project+action_type → project+workflow → workflow → action_type default
 * A node-level declaration lowers (never raises) whatever the scope resolved
 * to: a template author may be more cautious than policy, never less.
 */
export async function resolveAutonomy(args: {
  projectId: string | null;
  workflowKey: string;
  actionType: string;
  riskLevel: RiskLevel;
  workflowLevel: AutonomyLevel;
  nodeLevel?: AutonomyLevel;
}): Promise<AutonomyResolution> {
  const rows = await sql`
    select autonomy_level, project_id, workflow_key, action_type, risk_level, reason
    from autonomy_policies
    where (project_id = ${args.projectId} or project_id is null)
      and (workflow_key = ${args.workflowKey} or workflow_key is null)
      and (action_type = ${args.actionType} or action_type is null)
      and (risk_level = ${args.riskLevel} or risk_level is null)
  `;

  let resolved: AutonomyResolution;
  if (rows.length > 0) {
    // Specificity = number of non-null scope columns
    const scored = rows
      .map((r) => ({
        row: r,
        specificity:
          (r.projectId ? 1 : 0) +
          (r.workflowKey ? 1 : 0) +
          (r.actionType ? 1 : 0) +
          (r.riskLevel ? 1 : 0),
      }))
      .sort((a, b) => b.specificity - a.specificity);
    const best = scored[0]!.row;
    resolved = {
      level: Number(best.autonomyLevel) as AutonomyLevel,
      source: "policy",
      detail: (best.reason as string) || "autonomy policy override",
    };
  } else if (args.actionType in ACTION_TYPE_AUTONOMY) {
    resolved = {
      level: ACTION_TYPE_AUTONOMY[args.actionType]!,
      source: "action_type",
      detail: `shipped default for action type "${args.actionType}"`,
    };
  } else {
    resolved = {
      level: args.workflowLevel,
      source: "workflow",
      detail: `workflow "${args.workflowKey}" declared level ${args.workflowLevel}`,
    };
  }

  if (args.nodeLevel !== undefined && args.nodeLevel < resolved.level) {
    return {
      level: args.nodeLevel,
      source: "node",
      detail: `node lowered autonomy to ${args.nodeLevel} (scope resolved ${resolved.level})`,
    };
  }
  return resolved;
}

/** Does this level demand a human decision before the work counts as done? */
export function requiresApprovalFor(level: AutonomyLevel): boolean {
  return level <= APPROVAL_REQUIRED_AT_OR_BELOW;
}

/**
 * Node types that *do* something — act on the world or write a consequential
 * record. Only these are subject to autonomy gating.
 *
 * The distinction matters: a claim-verification gate inside a level-2 content
 * workflow is not the consequential act, it is the check that guards it.
 * Demanding a human decision on every gate, condition, and fan-out would make
 * a level-2 workflow unusable and would train the operator to rubber-stamp,
 * which is worse than no gate at all.
 */
const EFFECTFUL_NODE_TYPES = new Set<NodeType>([
  "deterministic_task",
  "agent_task",
  "integration_task",
  "manual_task",
]);

export function isEffectful(nodeType: NodeType): boolean {
  return EFFECTFUL_NODE_TYPES.has(nodeType);
}

/** Level 0 means the platform must not even prepare the action. */
export function isManualOnly(level: AutonomyLevel): boolean {
  return level === 0;
}
