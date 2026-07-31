/**
 * Human nodes and trigger nodes.
 *
 * A human node is an `approval_gate` with a *typed brief*: the summary, the
 * artifact, the evidence, and what the approver is being asked to decide. An
 * approval request with no evidence attached is refused here rather than
 * forwarded — an approver who cannot check anything is a rubber stamp, and a
 * rubber stamp is worse than no gate because it creates a false record of
 * oversight.
 *
 * Trigger nodes do not *cause* a run — the trigger system does. They record and
 * validate its provenance, so a run's origin is a node output rather than a log
 * line someone has to go find.
 */
import { resolve } from "@/lib/automation/nodes/paths";
import type { NodeHandler, NodeResult } from "@/lib/workflow/types";

interface HumanNodeSpec {
  /** What the approver is deciding. Shown verbatim in the approval queue. */
  question: string;
  /** Which upstream output holds the artifact under review. */
  defaultArtifactPath: string;
  /** Whether evidence is mandatory for this decision. */
  requiresEvidence: boolean;
}

const HUMAN_NODES: Record<string, HumanNodeSpec> = {
  approve_content: {
    question: "Is this asset accurate, supported, and safe to publish for this client?",
    defaultArtifactPath: "draft",
    requiresEvidence: true,
  },
  approve_outreach: {
    question: "Is every factual statement in this message supported, and is the ask appropriate?",
    defaultArtifactPath: "message",
    requiresEvidence: true,
  },
  approve_profile_correction: {
    question: "Is the correction accurate and appropriate to submit on the client's behalf?",
    defaultArtifactPath: "correction",
    requiresEvidence: true,
  },
  verify_transaction: {
    question: "Is the client's involvement in this transaction verified, and may it be used publicly?",
    defaultArtifactPath: "transaction",
    requiresEvidence: true,
  },
  approve_claim: {
    question: "Is this claim true, current, and safe to publish?",
    defaultArtifactPath: "claim",
    requiresEvidence: true,
  },
  review_attribution: {
    question: "Is this attribution classification defensible given the disclosed evidence?",
    defaultArtifactPath: "attribution",
    requiresEvidence: true,
  },
  review_low_confidence_result: {
    question: "The system's confidence was below threshold — what is the correct result?",
    defaultArtifactPath: "result",
    // A low-confidence review is precisely the case where the reviewer needs
    // whatever the system saw, even if it is thin.
    requiresEvidence: false,
  },
  choose_strategy: {
    question: "Which of the prepared options should this client's programme take?",
    defaultArtifactPath: "options",
    requiresEvidence: false,
  },
  approve_invoice_exception: {
    question: "This invoice deviates from the contract terms — approve, adjust, or reject?",
    defaultArtifactPath: "invoice",
    requiresEvidence: true,
  },
  approve_external_submission: {
    question: "Should this submission go to the external body on the client's behalf?",
    defaultArtifactPath: "submission",
    requiresEvidence: true,
  },
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Split what a template offered as "evidence" into stored evidence ids and
 * other supporting material.
 *
 * Both count as something an approver can check, but only the first can be
 * written to `workflow_approvals.evidence_ids` — that column is `uuid[]`, and
 * stringifying a metric object into it produces `[object Object]` and a
 * database error. The distinction is kept explicit rather than coerced.
 */
function splitEvidence(raw: unknown): { evidenceIds: string[]; supporting: unknown[] } {
  const items = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  const evidenceIds: string[] = [];
  const supporting: unknown[] = [];
  for (const item of items) {
    if (typeof item === "string" && UUID_PATTERN.test(item)) evidenceIds.push(item);
    else if (item !== undefined && item !== null) supporting.push(item);
  }
  return { evidenceIds, supporting };
}

function humanNode(key: string, spec: HumanNodeSpec): NodeHandler {
  return async (ctx): Promise<NodeResult> => {
    const artifactPath = String(ctx.config.artifactPath ?? spec.defaultArtifactPath);
    const artifact = await resolve(ctx, artifactPath);

    const evidencePath = String(ctx.config.evidenceIdsPath ?? "evidenceIds");
    const { evidenceIds, supporting } = splitEvidence(await resolve(ctx, evidencePath));

    if (spec.requiresEvidence && evidenceIds.length === 0 && supporting.length === 0) {
      return {
        outcome: "safe_stop",
        reason:
          `${key} requires something for the approver to check at "${evidencePath}", and nothing was attached. ` +
          "An approval with nothing to verify records oversight that did not happen.",
        output: { artifactPath, evidencePath, evidenceCount: 0, supportingCount: 0 },
      };
    }
    if (artifact === undefined || artifact === null) {
      return {
        outcome: "safe_stop",
        reason: `${key} found no artifact at "${artifactPath}" to review`,
      };
    }

    return {
      outcome: "awaiting_approval",
      reason: String(ctx.config.summary ?? spec.question),
      // Only real evidence ids reach the approval row.
      evidenceIds,
      output: {
        question: spec.question,
        artifact,
        artifactPath,
        evidenceIds,
        // Non-id material the approver should see — metric sets, computed
        // sections, verdict lists. Shown, not silently discarded.
        supportingMaterial: supporting,
        // What the approver may do. Surfaced so the UI does not invent options.
        decisions: ["approve", "reject", "request_changes"],
        requestedRole: ctx.node.approvalRole ?? "operator",
      },
    };
  };
}

export const humanNodes: Record<string, NodeHandler> = Object.fromEntries(
  Object.entries(HUMAN_NODES).map(([key, spec]) => [`hum.${key}`, humanNode(key, spec)])
);

// -------------------------------------------------------------- triggers

/**
 * A trigger node validates that the run's declared origin matches what actually
 * started it, and republishes the correlation id so every downstream node run
 * can be joined back to the event that caused the work.
 */
function triggerNode(expected: string): NodeHandler {
  return async (ctx): Promise<NodeResult> => {
    const declared = (ctx.workflowInput.trigger ?? {}) as {
      kind?: string;
      key?: string;
      reason?: string;
      slot?: string;
    };
    const event = (ctx.workflowInput.event ?? {}) as {
      id?: string;
      type?: string;
      correlationId?: string;
      occurredAt?: string;
    };

    // A domain-event run carries an `event` rather than a `trigger` block, so
    // both shapes are accepted for the event kind.
    const observed = declared.kind ?? (event.id ? "domain_event" : "unknown");
    if (observed !== expected) {
      return {
        outcome: "failed_terminal",
        error: `this graph declares a ${expected} entry point but the run was started by "${observed}"`,
      };
    }

    return {
      outcome: "succeeded",
      output: {
        kind: expected,
        triggerKey: declared.key ?? null,
        reason: declared.reason ?? null,
        slot: declared.slot ?? null,
        eventId: event.id ?? null,
        eventType: event.type ?? null,
        // The provenance chain, available to every downstream node.
        correlationId: event.correlationId ?? null,
        occurredAt: event.occurredAt ?? null,
        payload: ctx.workflowInput.payload ?? {},
      },
    };
  };
}

export const triggerNodes: Record<string, NodeHandler> = {
  "trg.schedule": triggerNode("schedule"),
  "trg.webhook": triggerNode("webhook"),
  "trg.domain_event": triggerNode("domain_event"),
  "trg.threshold": triggerNode("threshold"),
  "trg.manual": triggerNode("manual"),
};
