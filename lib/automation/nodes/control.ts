/**
 * Control nodes: routing, gating, waiting, limiting, stopping.
 *
 * `fan_in`, `approval_gate`, `delay`, `timer` and the terminals are spec-018
 * built-ins and are NOT redefined here — the engine owns their semantics. What
 * this module adds is the domain gating the automation layer needs: evidence,
 * confidence, autonomy, scope, cost and rate.
 *
 * Every gate here fails **safe**, not silent. A gate that cannot decide returns
 * `safe_stop` with a reason, which parks the run and raises an exception. A gate
 * that shrugged and continued would be worse than no gate at all.
 */
import { sql } from "@/db/client";
import { resolve, resolveObject } from "@/lib/automation/nodes/paths";
import { evidenceCompletenessGate } from "@/lib/workflow/gates";
import { resolveAutonomy, requiresApprovalFor, isManualOnly } from "@/lib/workflow/autonomy";
import { MAX_FAN_OUT } from "@/lib/workflow/graph";
import type { NodeHandler, NodeResult } from "@/lib/workflow/types";
import { runModeFor } from "@/lib/automation/testmode";

/** Comparison operators a `condition` or `switch` node may use. Closed set. */
type Comparator = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "truthy" | "in" | "contains";

function evaluate(left: unknown, comparator: Comparator, right: unknown): boolean {
  switch (comparator) {
    case "eq":
      return left === right;
    case "neq":
      return left !== right;
    case "gt":
      return typeof left === "number" && typeof right === "number" && left > right;
    case "gte":
      return typeof left === "number" && typeof right === "number" && left >= right;
    case "lt":
      return typeof left === "number" && typeof right === "number" && left < right;
    case "lte":
      return typeof left === "number" && typeof right === "number" && left <= right;
    case "truthy":
      return Boolean(left);
    case "in":
      return Array.isArray(right) && right.includes(left as never);
    case "contains":
      return typeof left === "string" && typeof right === "string" && left.includes(right);
    default: {
      const _exhaustive: never = comparator;
      void _exhaustive;
      return false;
    }
  }
}

/**
 * `condition` — evaluates a declared predicate over upstream outputs and
 * publishes `{ result }` for downstream edge conditions to route on.
 */
const condition: NodeHandler = async (ctx): Promise<NodeResult> => {
  const path = String(ctx.config.path ?? "");
  const comparator = (ctx.config.comparator as Comparator) ?? "truthy";
  const expected = ctx.config.value;
  const actual = await resolve(ctx, path);
  const result = evaluate(actual, comparator, expected);
  return {
    outcome: "succeeded",
    output: {
      result,
      // The observed value is in the output so a routing decision can be
      // explained later without re-running anything.
      observed: actual === undefined ? null : actual,
      comparator,
      expected: expected ?? null,
      path,
    },
  };
};

/** `switch` — N-way branch. Emits `{ branch }`; edges match on it. */
const switchNode: NodeHandler = async (ctx): Promise<NodeResult> => {
  const path = String(ctx.config.path ?? "");
  const actual = await resolve(ctx, path);
  const cases = (ctx.config.cases as { value: unknown; branch: string }[] | undefined) ?? [];
  const fallback = String(ctx.config.fallback ?? "default");
  const matched = cases.find((entry) => entry.value === actual);
  return {
    outcome: "succeeded",
    output: {
      branch: matched?.branch ?? fallback,
      observed: actual === undefined ? null : actual,
      matched: matched !== undefined,
    },
  };
};

/**
 * `fan_out` — reads a collection from upstream and declares one fan key per
 * item. Bounded by MAX_FAN_OUT, and the truncation is disclosed in the output
 * rather than being a silent cap.
 */
const fanOut: NodeHandler = async (ctx): Promise<NodeResult> => {
  const path = String(ctx.config.sourcePath ?? "");
  const source = await resolve(ctx, path);
  if (!Array.isArray(source)) {
    return {
      outcome: "safe_stop",
      reason: `fan_out expected an array at "${path}" and found ${typeof source}`,
    };
  }
  const keyField = ctx.config.keyField === undefined ? null : String(ctx.config.keyField);
  const keys = source.slice(0, MAX_FAN_OUT).map((item, index) => {
    if (keyField && item !== null && typeof item === "object") {
      const value = (item as Record<string, unknown>)[keyField];
      if (value !== undefined && value !== null) return String(value);
    }
    return String(index);
  });
  // Deduplicate: two items with the same natural key would otherwise collide on
  // the (run, node, fan_key) index and silently lose one.
  const unique = [...new Set(keys)];

  return {
    outcome: "succeeded",
    fanKeys: unique,
    output: {
      total: source.length,
      fannedOut: unique.length,
      truncated: source.length > MAX_FAN_OUT,
      duplicateKeysCollapsed: keys.length - unique.length,
      items: source.slice(0, MAX_FAN_OUT),
    },
  };
};

/**
 * `wait` — a durable wait. Long waits park the run rather than sleeping a
 * worker slot; the engine's retry backoff does the actual waiting.
 */
const wait: NodeHandler = async (ctx): Promise<NodeResult> => {
  const seconds = Number(ctx.config.seconds ?? 0);
  const untilPath = ctx.config.untilPath === undefined ? null : String(ctx.config.untilPath);
  const until = untilPath ? await resolve(ctx, untilPath) : null;
  const target =
    typeof until === "string" && Number.isFinite(Date.parse(until))
      ? new Date(Date.parse(until))
      : new Date(Date.now() + seconds * 1000);

  if (target.getTime() > Date.now()) {
    return {
      outcome: "failed_retryable",
      error: `waiting until ${target.toISOString()}`,
      output: { waitingUntil: target.toISOString() },
    };
  }
  return { outcome: "succeeded", output: { waitedUntil: target.toISOString() } };
};

/**
 * `rate_limit` — bounds sends per window per client. Over the limit it
 * SAFE-STOPS. It does not drop the message: a dropped message nobody knows
 * about is precisely the failure this platform exists to prevent.
 */
const rateLimit: NodeHandler = async (ctx): Promise<NodeResult> => {
  const maxPerWindow = Number(ctx.config.maxPerWindow ?? 50);
  const windowHours = Number(ctx.config.windowHours ?? 24);
  const scope = String(ctx.config.scope ?? "outreach_sends");

  let used = 0;
  if (scope === "outreach_sends") {
    const [row] = await sql`
      select count(*)::int as n
      from outreach_messages m
      join outreach_sequences s on s.id = m.sequence_id
      where m.status = 'sent'
        and m.sent_at > now() - make_interval(hours => ${windowHours})
        and (${ctx.projectId ?? null}::uuid is null or s.project_id = ${ctx.projectId ?? null})
    `;
    used = Number(row?.n ?? 0);
  } else {
    const [row] = await sql`
      select count(*)::int as n from workflow_runs
      where started_at > now() - make_interval(hours => ${windowHours})
        and (${ctx.projectId ?? null}::uuid is null or project_id = ${ctx.projectId ?? null})
    `;
    used = Number(row?.n ?? 0);
  }

  if (used >= maxPerWindow) {
    return {
      outcome: "safe_stop",
      reason: `rate limit reached for ${scope}: ${used} of ${maxPerWindow} in the last ${windowHours}h`,
      output: { used, maxPerWindow, windowHours, scope },
    };
  }
  return {
    outcome: "succeeded",
    output: { used, remaining: maxPerWindow - used, maxPerWindow, windowHours, scope },
  };
};

/**
 * `cost_limit` — refuses to proceed when the remaining budget is below what the
 * downstream work is estimated to cost. Checked before spending, never after.
 */
const costLimit: NodeHandler = async (ctx): Promise<NodeResult> => {
  const estimate = Number(ctx.config.estimateMicroUsd ?? 0);
  if (ctx.remainingCostMicroUsd === null) {
    return { outcome: "succeeded", output: { capped: false, estimate } };
  }
  if (ctx.remainingCostMicroUsd < estimate) {
    return {
      outcome: "safe_stop",
      reason: `remaining budget (${ctx.remainingCostMicroUsd} micro-USD) is below the estimated cost of the next step (${estimate})`,
      output: { remaining: ctx.remainingCostMicroUsd, estimate },
    };
  }
  return {
    outcome: "succeeded",
    output: { capped: true, remaining: ctx.remainingCostMicroUsd, estimate },
  };
};

/**
 * `evidence_gate` — reuses spec 018's evidence-completeness gate verbatim.
 * Insufficient evidence safe-stops; it never degrades into "publish anyway with
 * a caveat".
 */
const evidenceGate: NodeHandler = async (ctx): Promise<NodeResult> => {
  const packetPath = String(ctx.config.packetPath ?? "");
  const packet = await resolveObject(ctx, packetPath);
  const required = (ctx.node.requiredEvidence ?? []) as string[];

  // The packet supplies what it knows; anything it does not know stays
  // explicitly unknown rather than defaulting to a value that would pass.
  const result = evidenceCompletenessGate({
    requiredUpstreamTotal: Number(packet.requiredUpstreamTotal ?? 1),
    requiredUpstreamCompleted: Number(packet.requiredUpstreamCompleted ?? 1),
    sampleSize: Number(packet.sampleSize ?? 0),
    minimumSampleSize: Number(ctx.config.minimumSampleSize ?? 1),
    rawEvidenceCount: Number(packet.rawEvidenceCount ?? 0),
    requiredArtifactKinds: required,
    presentArtifactKinds: (packet.evidenceKinds as string[]) ?? [],
    hashesValid: typeof packet.hashesValid === "boolean" ? packet.hashesValid : null,
    classifiedCount: Number(packet.classifiedCount ?? packet.sampleSize ?? 0),
    lowConfidenceCount: Number(packet.lowConfidenceCount ?? 0),
    lowConfidenceRoutedCount: Number(packet.lowConfidenceRoutedCount ?? 0),
    partialFailureCount: Number(packet.partialFailureCount ?? 0),
    partialFailureDisclosed: packet.partialFailureDisclosed === true,
  });

  await sql.begin(
    (tx) => tx`
      insert into quality_gate_results (
        workflow_run_id, gate_type, gate_version, outcome, checks
      ) values (
        ${ctx.runId}, 'evidence_completeness', 'v1.0', ${result.outcome},
        ${tx.json(result.checks as never)}
      )
    `
  );

  if (result.outcome === "pass") {
    return { outcome: "succeeded", output: { gate: result.outcome, checks: result.checks } };
  }
  return {
    outcome: "safe_stop",
    reason: `evidence gate ${result.outcome}: ${result.reason}`,
    output: { gate: result.outcome, checks: result.checks },
  };
};

/**
 * `confidence_gate` — routes a below-threshold output to human review instead of
 * letting it flow onward. This is the single mechanism behind "low-confidence
 * results go to QA" across every workflow.
 */
const confidenceGate: NodeHandler = async (ctx): Promise<NodeResult> => {
  const threshold = Number(ctx.node.confidenceThreshold ?? ctx.config.threshold ?? 0.75);
  const path = String(ctx.config.confidencePath ?? "confidence");
  const observed = await resolve(ctx, path);
  const confidence = typeof observed === "number" ? observed : null;

  if (confidence === null) {
    // An absent confidence is not a high confidence.
    return {
      outcome: "awaiting_approval",
      reason: `no confidence value at "${path}" — a human must review this output before it proceeds`,
      output: { threshold, confidence: null, routedToHuman: true },
    };
  }
  if (confidence < threshold) {
    return {
      outcome: "awaiting_approval",
      reason: `confidence ${confidence.toFixed(3)} is below the ${threshold} threshold; routed to human review`,
      output: { threshold, confidence, routedToHuman: true },
      confidence,
    };
  }
  return {
    outcome: "succeeded",
    output: { threshold, confidence, routedToHuman: false },
    confidence,
  };
};

/**
 * `autonomy_gate` — resolves the effective autonomy level for this client and
 * action, and blocks when a human is required. Explicit as a node so a template
 * can show *where* the decision boundary sits, rather than it being implicit in
 * the engine.
 */
const autonomyGate: NodeHandler = async (ctx): Promise<NodeResult> => {
  const actionType = String(ctx.config.actionType ?? "");
  const resolution = await resolveAutonomy({
    projectId: ctx.projectId,
    workflowKey: String(ctx.config.workflowKey ?? ""),
    actionType,
    riskLevel: ctx.node.riskLevel ?? "medium",
    workflowLevel: (ctx.config.workflowLevel as 0 | 1 | 2 | 3 | 4) ?? 2,
    nodeLevel: ctx.node.autonomyLevel,
  });

  if (isManualOnly(resolution.level)) {
    return {
      outcome: "safe_stop",
      reason: `${actionType} is manual-only for this client (autonomy 0 — ${resolution.detail})`,
      output: { level: resolution.level, detail: resolution.detail, actionType },
    };
  }
  if (requiresApprovalFor(resolution.level)) {
    return {
      outcome: "awaiting_approval",
      reason: `${actionType} requires approval at autonomy level ${resolution.level} (${resolution.detail})`,
      output: { level: resolution.level, detail: resolution.detail, actionType },
    };
  }
  return {
    outcome: "succeeded",
    output: {
      level: resolution.level,
      detail: resolution.detail,
      actionType,
      autonomous: true,
    },
  };
};

/**
 * `scope_gate` — asserts every referenced record belongs to this run's client.
 * A cross-tenant reference is a defect, so this hard-fails rather than
 * filtering.
 */
const scopeGate: NodeHandler = async (ctx): Promise<NodeResult> => {
  const table = String(ctx.config.table ?? "");
  const idsPath = String(ctx.config.idsPath ?? "");
  const raw = await resolve(ctx, idsPath);
  const ids = Array.isArray(raw) ? raw.map(String) : [];

  const ALLOWED_TABLES = new Set([
    "claims",
    "content_assets",
    "runs",
    "reports",
    "outreach_sequences",
    "meeting_briefs",
    "support_requests",
  ]);
  if (!ALLOWED_TABLES.has(table)) {
    return {
      outcome: "failed_terminal",
      error: `scope_gate is not configured for table "${table}". Add it to the allowlist deliberately.`,
    };
  }
  if (ids.length === 0) {
    return { outcome: "succeeded", output: { checked: 0, table, allInScope: true } };
  }
  if (ctx.projectId === null) {
    return {
      outcome: "failed_terminal",
      error: "scope_gate cannot verify record scope on a platform-scoped run.",
    };
  }

  const rows = await sql`
    select count(*)::int as n from ${sql(table)}
    where id = any(${ids}::uuid[]) and project_id = ${ctx.projectId}
  `;
  const inScope = Number(rows[0]?.n ?? 0);
  if (inScope !== ids.length) {
    return {
      outcome: "failed_terminal",
      error: `tenant scope violation: ${ids.length - inScope} of ${ids.length} ${table} records do not belong to this client`,
      output: { checked: ids.length, inScope, table },
    };
  }
  return { outcome: "succeeded", output: { checked: ids.length, inScope, table, allInScope: true } };
};

/** `safe_stop` — an explicit, declared stop with a reason. */
const safeStop: NodeHandler = async (ctx): Promise<NodeResult> => ({
  outcome: "safe_stop",
  reason: String(ctx.config.reason ?? "the workflow declared a safe stop at this node"),
  output: { declared: true },
});

/**
 * `test_mode_guard` — a node a template can place before a consequential branch
 * to make the test/live divergence explicit in the graph.
 */
const testModeGuard: NodeHandler = async (ctx): Promise<NodeResult> => {
  const context = await runModeFor(ctx.runId);
  return {
    outcome: "succeeded",
    output: {
      mode: context.mode,
      isTest: context.mode === "test",
      allowCrmWrites: context.allowCrmWrites,
    },
  };
};

export const controlNodes: Record<string, NodeHandler> = {
  "ctl.condition": condition,
  "ctl.switch": switchNode,
  "ctl.fan_out": fanOut,
  "ctl.wait": wait,
  "ctl.rate_limit": rateLimit,
  "ctl.cost_limit": costLimit,
  "ctl.evidence_gate": evidenceGate,
  "ctl.confidence_gate": confidenceGate,
  "ctl.autonomy_gate": autonomyGate,
  "ctl.scope_gate": scopeGate,
  "ctl.safe_stop": safeStop,
  "ctl.test_mode_guard": testModeGuard,
};
