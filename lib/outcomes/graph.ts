/**
 * The action-to-outcome graph (spec 019, Part 21).
 *
 * This module holds the one rule the whole platform's credibility rests on:
 * **correlation is never promoted to causation by software.** A relationship
 * may be labelled `confirmed` only when a hard identifier ties the two ends
 * together, or when a human says so and signs their name to it. An agent's
 * opinion caps at `correlated`.
 */
import { sql, type TransactionSql } from "@/db/client";
import { ClassifiedError } from "@/lib/errors";

type Tx = TransactionSql | typeof sql;

export const CONFIDENCE_LABELS = [
  "confirmed",
  "strongly_supported",
  "correlated",
  "probable",
  "unknown",
] as const;
export type ConfidenceLabel = (typeof CONFIDENCE_LABELS)[number];

export type CreatorKind = "human" | "deterministic" | "agent";

/**
 * The ceiling each creator may assign. Deterministic code can reach
 * `confirmed` only via `hasMatchingIdentifier` (checked below); an agent
 * cannot reach it at all, at any confidence, ever.
 */
const CREATOR_CEILING: Record<CreatorKind, ConfidenceLabel> = {
  human: "confirmed",
  deterministic: "confirmed",
  agent: "correlated",
};

const RANK: Record<ConfidenceLabel, number> = {
  unknown: 0,
  probable: 1,
  correlated: 2,
  strongly_supported: 3,
  confirmed: 4,
};

export const EFFECTIVENESS_LABELS = [
  "positive_signal",
  "no_detectable_change",
  "negative_signal",
  "inconclusive",
  "insufficient_measurement",
  "confounded",
] as const;
export type EffectivenessLabel = (typeof EFFECTIVENESS_LABELS)[number];

/**
 * Guard the confidence label. Returns the label that may actually be written,
 * plus the reason when it was lowered — the reason is stored so a reader can
 * see the system declined to overclaim rather than simply lacking data.
 */
export function boundConfidence(args: {
  requested: ConfidenceLabel;
  createdByKind: CreatorKind;
  hasMatchingIdentifier: boolean;
  hasSelfReport: boolean;
}): { label: ConfidenceLabel; lowered: boolean; reason: string } {
  const ceiling = CREATOR_CEILING[args.createdByKind];
  let label = args.requested;
  let reason = "";

  if (RANK[label] > RANK[ceiling]) {
    reason = `${args.createdByKind} may not assert "${args.requested}"; capped at "${ceiling}"`;
    label = ceiling;
  }

  // `confirmed` additionally demands hard evidence, whoever is asking.
  if (
    label === "confirmed" &&
    !args.hasMatchingIdentifier &&
    !args.hasSelfReport &&
    args.createdByKind !== "human"
  ) {
    reason =
      'no matching identifier or self-report supports "confirmed"; lowered to "strongly_supported"';
    label = "strongly_supported";
  }

  return { label, lowered: label !== args.requested, reason };
}

export interface RelationshipInput {
  projectId: string;
  fromKind: string;
  fromId: string;
  toKind: string;
  toId: string;
  relation: string;
  requestedConfidence: ConfidenceLabel;
  basis: string;
  evidenceIds?: string[];
  createdByKind: CreatorKind;
  createdBy?: string | null;
  hasMatchingIdentifier?: boolean;
  hasSelfReport?: boolean;
}

/** Write one typed edge into the outcome graph, with the guard applied. */
export async function recordRelationship(
  tx: Tx,
  input: RelationshipInput
): Promise<{ id: string | null; label: ConfidenceLabel; lowered: boolean }> {
  const bounded = boundConfidence({
    requested: input.requestedConfidence,
    createdByKind: input.createdByKind,
    hasMatchingIdentifier: input.hasMatchingIdentifier ?? false,
    hasSelfReport: input.hasSelfReport ?? false,
  });
  const basis = bounded.lowered ? `${input.basis} [${bounded.reason}]` : input.basis;

  const [row] = await tx`
    insert into outcome_relationships (
      project_id, from_kind, from_id, to_kind, to_id, relation, confidence_label,
      basis, evidence_ids, created_by_kind, created_by
    ) values (
      ${input.projectId}, ${input.fromKind}, ${input.fromId}, ${input.toKind},
      ${input.toId}, ${input.relation}, ${bounded.label}, ${basis},
      ${input.evidenceIds ?? []}, ${input.createdByKind}, ${input.createdBy ?? null}
    )
    on conflict (from_kind, from_id, to_kind, to_id, relation) do nothing
    returning id
  `;
  return { id: (row?.id as string) ?? null, label: bounded.label, lowered: bounded.lowered };
}

// ------------------------------------------------------ effectiveness

export interface MeasurementPair {
  before: number | null;
  after: number | null;
}

export interface EffectivenessInput {
  visibility: MeasurementPair;
  citations: MeasurementPair;
  traffic: MeasurementPair;
  leads: MeasurementPair;
  /** Minimum relative movement that counts as a signal rather than noise. */
  materialityThreshold: number;
  confounders: string[];
  /** Days elapsed vs the action's expected time to impact. */
  daysElapsed: number | null;
  expectedDaysToImpact: number | null;
}

/**
 * Label what an action appears to have done. Deliberately conservative: the
 * default is `insufficient_measurement`, and confounders win over a positive
 * reading — a number that moved while three other things changed is not
 * evidence that this action moved it.
 */
export function labelEffectiveness(input: EffectivenessInput): {
  label: EffectivenessLabel;
  reason: string;
} {
  const pairs: [string, MeasurementPair][] = [
    ["visibility", input.visibility],
    ["citations", input.citations],
    ["traffic", input.traffic],
    ["leads", input.leads],
  ];
  const measured = pairs.filter(([, p]) => p.before !== null && p.after !== null);

  if (measured.length === 0) {
    return {
      label: "insufficient_measurement",
      reason: "no metric has both a before and an after value",
    };
  }
  if (
    input.expectedDaysToImpact !== null &&
    input.daysElapsed !== null &&
    input.daysElapsed < input.expectedDaysToImpact
  ) {
    return {
      label: "insufficient_measurement",
      reason: `only ${input.daysElapsed}d elapsed of an expected ${input.expectedDaysToImpact}d to impact`,
    };
  }

  const moves = measured.map(([name, p]) => {
    const before = p.before!;
    const after = p.after!;
    const relative = before === 0 ? (after === 0 ? 0 : 1) : (after - before) / Math.abs(before);
    return { name, relative };
  });
  const up = moves.filter((m) => m.relative >= input.materialityThreshold);
  const down = moves.filter((m) => m.relative <= -input.materialityThreshold);

  if (up.length === 0 && down.length === 0) {
    return {
      label: "no_detectable_change",
      reason: `no metric moved more than ${(input.materialityThreshold * 100).toFixed(0)}%`,
    };
  }
  if (input.confounders.length > 0) {
    return {
      label: "confounded",
      reason: `movement observed but ${input.confounders.length} confounder(s) present: ${input.confounders.join(", ")}`,
    };
  }
  if (up.length > 0 && down.length > 0) {
    return {
      label: "inconclusive",
      reason: `metrics moved in both directions (up: ${up.map((m) => m.name).join(", ")}; down: ${down.map((m) => m.name).join(", ")})`,
    };
  }
  if (up.length > 0) {
    return {
      label: "positive_signal",
      reason: `${up.map((m) => `${m.name} ${(m.relative * 100).toFixed(0)}%`).join(", ")} — association, not proof of cause`,
    };
  }
  return {
    label: "negative_signal",
    reason: `${down.map((m) => `${m.name} ${(m.relative * 100).toFixed(0)}%`).join(", ")} — association, not proof of cause`,
  };
}

// --------------------------------------------------------- action records

export interface RecordActionInput {
  projectId: string;
  actionType: string;
  hypothesis?: string;
  gapFindingId?: string | null;
  taskId?: string | null;
  contentAssetId?: string | null;
  interventionId?: string | null;
  workflowRunId?: string | null;
  stateBefore?: Record<string, unknown>;
  assets?: unknown[];
  promptClusterKeys?: string[];
  landingUrls?: string[];
  completedOn?: string | null;
  expectedDaysToImpact?: number | null;
  evidenceIds?: string[];
}

export async function recordAction(tx: Tx, input: RecordActionInput): Promise<string> {
  const [row] = await tx`
    insert into action_outcomes (
      project_id, gap_finding_id, task_id, content_asset_id, intervention_id,
      workflow_run_id, action_type, hypothesis, state_before, assets,
      prompt_cluster_keys, landing_urls, completed_on, expected_days_to_impact,
      evidence_ids
    ) values (
      ${input.projectId}, ${input.gapFindingId ?? null}, ${input.taskId ?? null},
      ${input.contentAssetId ?? null}, ${input.interventionId ?? null},
      ${input.workflowRunId ?? null}, ${input.actionType}, ${input.hypothesis ?? ""},
      ${tx.json((input.stateBefore ?? {}) as never)},
      ${tx.json((input.assets ?? []) as never)},
      ${input.promptClusterKeys ?? []}, ${input.landingUrls ?? []},
      ${input.completedOn ?? null}, ${input.expectedDaysToImpact ?? null},
      ${input.evidenceIds ?? []}
    )
    returning id
  `;
  return row!.id as string;
}

/**
 * Attach the "after" measurements and settle the effectiveness label. Writes
 * once — an outcome that has already been measured is not re-measured in
 * place, because a client was told the earlier number.
 */
export async function measureAction(
  tx: Tx,
  args: {
    actionOutcomeId: string;
    after: {
      visibility?: number | null;
      citations?: number | null;
      traffic?: number | null;
      leads?: number | null;
      pipeline?: number | null;
    };
    before?: {
      visibility?: number | null;
      citations?: number | null;
      traffic?: number | null;
      leads?: number | null;
      pipeline?: number | null;
    };
    confounders?: string[];
    materialityThreshold: number;
    humanInterpretation?: string | null;
  }
): Promise<{ label: EffectivenessLabel; reason: string }> {
  const [existing] = await tx`
    select * from action_outcomes where id = ${args.actionOutcomeId} for update
  `;
  if (!existing) throw new ClassifiedError("not_found", "Action outcome not found.");
  if (existing.measuredAt) {
    throw new ClassifiedError(
      "conflict",
      "This action outcome has already been measured; record a new outcome instead of overwriting it."
    );
  }

  const before = {
    visibility: args.before?.visibility ?? numOrNull(existing.visibilityBefore),
    citations: args.before?.citations ?? numOrNull(existing.citationsBefore),
    traffic: args.before?.traffic ?? numOrNull(existing.trafficBefore),
    leads: args.before?.leads ?? numOrNull(existing.leadsBefore),
    pipeline: args.before?.pipeline ?? numOrNull(existing.pipelineBefore),
  };
  const completedOn = existing.completedOn as Date | null;
  const daysElapsed = completedOn
    ? Math.floor((Date.now() - completedOn.getTime()) / 86_400_000)
    : null;

  const verdict = labelEffectiveness({
    visibility: { before: before.visibility, after: args.after.visibility ?? null },
    citations: { before: before.citations, after: args.after.citations ?? null },
    traffic: { before: before.traffic, after: args.after.traffic ?? null },
    leads: { before: before.leads, after: args.after.leads ?? null },
    materialityThreshold: args.materialityThreshold,
    confounders: args.confounders ?? [],
    daysElapsed,
    expectedDaysToImpact: numOrNull(existing.expectedDaysToImpact),
  });

  await tx`
    update action_outcomes set
      visibility_before = ${before.visibility}, visibility_after = ${args.after.visibility ?? null},
      citations_before = ${before.citations}, citations_after = ${args.after.citations ?? null},
      traffic_before = ${before.traffic}, traffic_after = ${args.after.traffic ?? null},
      leads_before = ${before.leads}, leads_after = ${args.after.leads ?? null},
      pipeline_before = ${before.pipeline}, pipeline_after = ${args.after.pipeline ?? null},
      effectiveness = ${verdict.label},
      confounders = ${args.confounders ?? []},
      human_interpretation = ${args.humanInterpretation ?? null},
      measured_at = now()
    where id = ${args.actionOutcomeId}
  `;
  return verdict;
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// ------------------------------------------------------------- reading

export interface OutcomeChainNode {
  kind: string;
  id: string;
  relation: string;
  confidenceLabel: ConfidenceLabel;
  basis: string;
}

/**
 * Walk the outcome graph forward from a starting node, breadth-first, bounded.
 * The weakest link is reported alongside the chain — a chain is only as
 * confident as its least certain edge, and saying so is the point.
 */
export async function outcomeChain(
  projectId: string,
  start: { kind: string; id: string },
  maxDepth = 8
): Promise<{ chain: OutcomeChainNode[]; weakestLink: ConfidenceLabel | null }> {
  const chain: OutcomeChainNode[] = [];
  let frontier = [start];
  const seen = new Set<string>([`${start.kind}:${start.id}`]);

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
    const kinds = frontier.map((f) => f.kind);
    const ids = frontier.map((f) => f.id);
    const rows = await sql`
      select from_kind, from_id, to_kind, to_id, relation, confidence_label, basis
      from outcome_relationships
      where project_id = ${projectId}
        and from_kind = any(${kinds}) and from_id = any(${ids})
      order by created_at asc
    `;
    const next: { kind: string; id: string }[] = [];
    for (const row of rows) {
      const key = `${row.toKind}:${row.toId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      chain.push({
        kind: row.toKind as string,
        id: row.toId as string,
        relation: row.relation as string,
        confidenceLabel: row.confidenceLabel as ConfidenceLabel,
        basis: row.basis as string,
      });
      next.push({ kind: row.toKind as string, id: row.toId as string });
    }
    frontier = next;
  }

  const weakestLink =
    chain.length === 0
      ? null
      : chain.reduce<ConfidenceLabel>(
          (weakest, node) =>
            RANK[node.confidenceLabel] < RANK[weakest] ? node.confidenceLabel : weakest,
          "confirmed"
        );
  return { chain, weakestLink };
}
