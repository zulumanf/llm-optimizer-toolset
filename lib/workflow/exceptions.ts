/**
 * The exception queue (spec 018 Part 13, spec 019 Part B).
 *
 * The operating model: nobody inspects every client every day. Everything that
 * needs a human becomes an exception row with an owner, a due date, and an SLA,
 * and one deterministic formula orders them across the whole portfolio.
 */
import { sql, type TransactionSql } from "@/db/client";
import type { RiskLevel } from "@/lib/workflow/types";

type Tx = TransactionSql | typeof sql;

/** Exception kinds. Adding one means adding its SLA below — no silent defaults. */
export const EXCEPTION_KINDS = [
  "low_confidence_classification",
  "evidence_conflict",
  "expired_claim",
  "failed_integration",
  "failed_workflow",
  "missing_client_input",
  "client_approval",
  "compliance_approval",
  "publication_failure",
  "attribution_ambiguity",
  "visibility_decline",
  "high_value_opportunity",
  "ranking_deadline",
  "media_opportunity",
  "renewal_risk",
  "cost_anomaly",
  "verifier_disagreement",
  "adversarial_issue",
  "safe_stop",
] as const;
export type ExceptionKind = (typeof EXCEPTION_KINDS)[number];

/** Hours to resolution, by kind. Drives `due_at` and the overdue component. */
export const EXCEPTION_SLA_HOURS: Record<ExceptionKind, number> = {
  low_confidence_classification: 72,
  evidence_conflict: 24,
  expired_claim: 168,
  failed_integration: 24,
  failed_workflow: 8,
  missing_client_input: 120,
  client_approval: 72,
  compliance_approval: 48,
  publication_failure: 8,
  attribution_ambiguity: 168,
  visibility_decline: 48,
  high_value_opportunity: 168,
  ranking_deadline: 24,
  media_opportunity: 48,
  renewal_risk: 72,
  cost_anomaly: 24,
  verifier_disagreement: 48,
  adversarial_issue: 24,
  safe_stop: 24,
};

export interface RaiseExceptionInput {
  projectId: string | null;
  workflowRunId?: string | null;
  nodeRunId?: string | null;
  kind: ExceptionKind;
  severity: RiskLevel;
  summary: string;
  detail?: Record<string, unknown>;
  evidenceIds?: string[];
  recommendedAction?: string;
  owner?: string | null;
  escalationPath?: string;
}

/**
 * Raise an exception, or leave the existing open one alone. The partial unique
 * index on (node_run_id, kind) means a retrying tick cannot spam the queue —
 * the operator sees one row per real problem.
 */
export async function raiseException(
  tx: Tx,
  input: RaiseExceptionInput
): Promise<string | null> {
  const slaHours = EXCEPTION_SLA_HOURS[input.kind];
  const [row] = await tx`
    insert into workflow_exceptions (
      project_id, workflow_run_id, node_run_id, kind, severity, summary, detail,
      evidence_ids, recommended_action, owner, escalation_path, sla_hours, due_at
    ) values (
      ${input.projectId}, ${input.workflowRunId ?? null}, ${input.nodeRunId ?? null},
      ${input.kind}, ${input.severity}, ${input.summary},
      ${tx.json((input.detail ?? {}) as never)}, ${input.evidenceIds ?? []},
      ${input.recommendedAction ?? ""}, ${input.owner ?? null},
      ${input.escalationPath ?? "operator"}, ${slaHours},
      now() + make_interval(hours => ${slaHours})
    )
    on conflict do nothing
    returning id
  `;
  return (row?.id as string) ?? null;
}

export async function resolveException(
  tx: Tx,
  args: { id: string; status: "resolved" | "dismissed"; resolution: string; userId: string }
): Promise<boolean> {
  const rows = await tx`
    update workflow_exceptions set
      status = ${args.status}, resolution = ${args.resolution},
      resolved_by = ${args.userId}, resolved_at = now()
    where id = ${args.id} and status in ('open', 'acknowledged')
    returning id
  `;
  return rows.length > 0;
}

// ------------------------------------------------------- priority formula

export const PRIORITY_FORMULA_VERSION = "v1.0";

/** Weights sum to 1.0. Changing one is a versioned methodology change. */
export const PRIORITY_WEIGHTS = {
  severity: 0.3,
  timeSensitivity: 0.2,
  commercialValue: 0.2,
  dependencyImpact: 0.15,
  risk: 0.1,
  effort: 0.05,
} as const;

const SEVERITY_SCORE: Record<RiskLevel, number> = {
  critical: 1,
  high: 0.7,
  medium: 0.4,
  low: 0.15,
};

export interface PriorityInputs {
  severity: RiskLevel;
  /** Hours until due; negative means overdue. Null when nothing is due. */
  hoursUntilDue: number | null;
  /** 0..1 — normalised commercial value of the underlying item. */
  commercialValue: number;
  /** 0..1 — share of downstream work this is blocking. */
  dependencyImpact: number;
  /** 0..1 — legal / privacy / publication exposure. */
  risk: number;
  /** Estimated minutes of human effort; cheap wins break ties upward. */
  effortMinutes: number;
}

export interface PriorityBreakdown {
  total: number;
  formulaVersion: string;
  components: { name: string; weight: number; score: number; contribution: number }[];
}

export function timeSensitivityScore(hoursUntilDue: number | null): number {
  if (hoursUntilDue === null) return 0.1;
  if (hoursUntilDue <= 0) return 1;
  if (hoursUntilDue <= 24) return 0.8;
  if (hoursUntilDue <= 168) return 0.4;
  return 0.1;
}

/** Inverted effort on a 0..1 scale: a 15-minute fix scores higher than a day. */
export function effortScore(effortMinutes: number): number {
  const bounded = Math.max(5, Math.min(480, effortMinutes));
  return 1 - (bounded - 5) / 475;
}

/**
 * Deterministic priority, 0-100, with every component exposed. The UI renders
 * the breakdown next to the number — a score the operator cannot decompose is
 * not a score we are willing to show (PRINCIPLES #4).
 */
export function computePriority(inputs: PriorityInputs): PriorityBreakdown {
  const scores = {
    severity: SEVERITY_SCORE[inputs.severity],
    timeSensitivity: timeSensitivityScore(inputs.hoursUntilDue),
    commercialValue: clamp01(inputs.commercialValue),
    dependencyImpact: clamp01(inputs.dependencyImpact),
    risk: clamp01(inputs.risk),
    effort: effortScore(inputs.effortMinutes),
  };
  const components = (Object.keys(PRIORITY_WEIGHTS) as (keyof typeof PRIORITY_WEIGHTS)[]).map(
    (name) => {
      const weight = PRIORITY_WEIGHTS[name];
      const score = scores[name];
      return { name, weight, score, contribution: weight * score };
    }
  );
  const total = components.reduce((sum, c) => sum + c.contribution, 0) * 100;
  return {
    total: Math.round(total * 10) / 10,
    formulaVersion: PRIORITY_FORMULA_VERSION,
    components,
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
