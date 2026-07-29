/**
 * Integration nodes — one per connector capability.
 *
 * Every one is the same three lines: read the payload, call
 * `executeCapability`, return the result. That uniformity is the point. There is
 * no provider name in this file, no vendor SDK, no auth header, and no token —
 * a node describes *what* it wants done and the connector layer decides how.
 *
 * The send path is the exception, and deliberately so: `int.email_send_approved`
 * runs the seven-check send gate before it will touch a provider. Making that
 * the only route to a send is what makes the gate meaningful.
 */
import { sql } from "@/db/client";
import { resolve } from "@/lib/automation/nodes/paths";
import { executeCapability } from "@/lib/connectors/execute";
import { CONNECTOR_CAPABILITIES, type ConnectorCapability } from "@/lib/connectors/types";
import { runModeFor, recordWouldHaveHappened } from "@/lib/automation/testmode";
import { assertSendAllowed } from "@/lib/outreach/suppression";
import { hashBody } from "@/lib/outreach/sequences";
import { resolveAutonomy } from "@/lib/workflow/autonomy";
import type { NodeHandler, NodeResult } from "@/lib/workflow/types";

/**
 * Build the payload for a capability call: static `params` from the node
 * config, overlaid with whatever the upstream node produced at `inputPath`.
 * Config is the default, upstream data wins — a template can set a fallback
 * without preventing a node from computing a better value.
 */
async function payloadFor(
  ctx: Parameters<NodeHandler>[0]
): Promise<Record<string, unknown>> {
  const params = (ctx.config.params as Record<string, unknown> | undefined) ?? {};
  const inputPath = ctx.config.inputPath === undefined ? null : String(ctx.config.inputPath);
  const upstream = inputPath ? await resolve(ctx, inputPath) : null;
  const dynamic =
    upstream !== null && typeof upstream === "object" && !Array.isArray(upstream)
      ? (upstream as Record<string, unknown>)
      : {};
  return { ...params, ...dynamic };
}

/** The generic capability node. All non-send integration nodes use it. */
function capabilityNode(capability: ConnectorCapability): NodeHandler {
  return async (ctx): Promise<NodeResult> => {
    const mode = await runModeFor(ctx.runId);
    const result = await executeCapability({
      capability,
      projectId: ctx.projectId,
      input: await payloadFor(ctx),
      mode: mode.mode,
      provider: ctx.config.provider === undefined ? undefined : String(ctx.config.provider),
      workflowRunId: ctx.runId,
      nodeRunId: null,
      fixtures: mode.fixtures.connectorResponses,
      allowCrmWrites: mode.allowCrmWrites,
    });

    if (result.ok) {
      return {
        outcome: "succeeded",
        output: {
          ok: true,
          capability,
          provider: result.provider,
          data: result.data as Record<string, unknown>,
          rowsRead: result.rowsRead,
          rowsWritten: result.rowsWritten,
          mode: mode.mode,
        },
      };
    }

    // Test-mode refusals are a successful outcome for a test run: the run
    // continues and the ledger records what would have happened.
    if (result.errorCode === "test_mode_refused") {
      return {
        outcome: "succeeded",
        output: {
          ok: false,
          skipped: true,
          capability,
          reason: result.error,
          wouldHaveSent: result.wouldHaveSent ?? {},
          mode: mode.mode,
        },
      };
    }

    // A missing fixture in a test run is the test's fault, and saying so is more
    // useful than a generic integration failure.
    if (result.errorCode === "fixture_missing") {
      return {
        outcome: "failed_terminal",
        error: result.error ?? "fixture missing",
        output: { ok: false, capability, mode: mode.mode },
      };
    }

    return {
      outcome: result.retryable ? "failed_retryable" : "failed_terminal",
      error: result.error ?? `${capability} failed`,
      output: {
        ok: false,
        capability,
        provider: result.provider,
        errorCode: result.errorCode,
        statusCode: result.statusCode,
        rateLimited: result.rateLimited,
      },
    };
  };
}

/**
 * The send node. Runs the seven-check gate, then sends. Every refusal path
 * records what would have happened, because "we didn't send and nobody knows
 * why" is the failure mode that erodes trust in automation.
 */
const emailSendApproved: NodeHandler = async (ctx): Promise<NodeResult> => {
  const mode = await runModeFor(ctx.runId);
  const payload = await payloadFor(ctx);

  const recipient = String(payload.to ?? "");
  const subject = String(payload.subject ?? "");
  const body = String(payload.body ?? "");
  if (recipient.length === 0 || body.length === 0) {
    return {
      outcome: "failed_terminal",
      error: "email_send_approved needs a recipient and a body",
    };
  }

  const autonomy = await resolveAutonomy({
    projectId: ctx.projectId,
    workflowKey: String(ctx.config.workflowKey ?? ""),
    actionType: String(ctx.config.actionType ?? "outreach_send"),
    riskLevel: ctx.node.riskLevel ?? "high",
    workflowLevel: (ctx.config.workflowLevel as 0 | 1 | 2 | 3 | 4) ?? 2,
    nodeLevel: ctx.node.autonomyLevel,
  });

  const verdict = await assertSendAllowed({
    projectId: ctx.projectId,
    recipientEmail: recipient,
    bodyHash: hashBody(subject, body),
    approvalId: payload.approvalId === undefined ? null : String(payload.approvalId),
    autonomyLevel: autonomy.level,
    hasRelationship: payload.hasRelationship === true,
    businessPurpose: payload.businessPurpose === undefined ? null : String(payload.businessPurpose),
    unsubscribeUrl: payload.unsubscribeUrl === undefined ? null : String(payload.unsubscribeUrl),
    connectionProjectId: ctx.projectId,
    runMode: mode.mode,
  });

  if (!verdict.allowed) {
    await recordWouldHaveHappened({
      workflowRunId: ctx.runId,
      capability: "email.send_approved_message",
      payload: { to: recipient, subject, bodyHash: hashBody(subject, body) },
      reason: `send gate refused at "${verdict.failedCheck}": ${verdict.reason}`,
    });

    // A suppression or a test run is a legitimate stop, not a failure. A missing
    // approval is a stop too — the run parks rather than dying, so a human can
    // still approve it.
    const benign =
      verdict.failedCheck === "run_mode" ||
      verdict.failedCheck === "suppression" ||
      verdict.failedCheck === "approval";
    return {
      outcome: benign ? "safe_stop" : "failed_terminal",
      reason: verdict.reason,
      error: benign ? undefined : verdict.reason,
      output: {
        ok: false,
        sent: false,
        failedCheck: verdict.failedCheck,
        checks: verdict.checks,
        mode: mode.mode,
      },
    };
  }

  const result = await executeCapability({
    capability: "email.send_approved_message",
    projectId: ctx.projectId,
    input: payload,
    mode: mode.mode,
    provider: ctx.config.provider === undefined ? undefined : String(ctx.config.provider),
    workflowRunId: ctx.runId,
    fixtures: mode.fixtures.connectorResponses,
  });

  if (!result.ok) {
    return {
      outcome: result.retryable ? "failed_retryable" : "failed_terminal",
      error: result.error ?? "send failed",
      output: { ok: false, sent: false, errorCode: result.errorCode, checks: verdict.checks },
    };
  }

  const data = (result.data ?? {}) as { messageId?: string; threadId?: string };
  return {
    outcome: "succeeded",
    output: {
      ok: true,
      sent: true,
      messageId: data.messageId ?? null,
      threadId: data.threadId ?? null,
      provider: result.provider,
      checks: verdict.checks,
      mode: mode.mode,
    },
  };
};

/**
 * `int.cms_publish_approved` — publication requires the approval id, and the
 * node refuses without one before it reaches the connector.
 */
const cmsPublishApproved: NodeHandler = async (ctx): Promise<NodeResult> => {
  const payload = await payloadFor(ctx);
  if (String(payload.approvalId ?? "").length === 0) {
    return {
      outcome: "safe_stop",
      reason: "publication requires the id of the approval that released it",
    };
  }
  const [approval] = await sql`
    select decision from workflow_approvals where id = ${String(payload.approvalId)}::uuid
  `;
  if (!approval || approval.decision !== "approved") {
    return {
      outcome: "safe_stop",
      reason: `the referenced approval is "${(approval?.decision as string | null) ?? "missing"}"; publication is refused`,
    };
  }
  return capabilityNode("cms.publish_approved_asset")({ ...ctx, config: { ...ctx.config, params: payload } });
};

/**
 * `int.billing_create_invoice` — refuses an amount that did not come from a
 * deterministic node. An LLM must never be upstream of an invoice total.
 */
const billingCreateInvoice: NodeHandler = async (ctx): Promise<NodeResult> => {
  const payload = await payloadFor(ctx);
  const amountCents = payload.amountCents;
  if (typeof amountCents !== "number" || !Number.isInteger(amountCents) || amountCents <= 0) {
    return {
      outcome: "failed_terminal",
      error:
        "invoice creation requires a positive integer amountCents from a deterministic calculation",
    };
  }
  if (payload.computedBy !== "deterministic") {
    return {
      outcome: "failed_terminal",
      error:
        'invoice amount must be marked computedBy: "deterministic" — an LLM-derived total is not acceptable',
    };
  }
  return capabilityNode("billing.create_invoice")({ ...ctx, config: { ...ctx.config, params: payload } });
};

/** Build a node for every capability, then override the guarded ones. */
const generated: Record<string, NodeHandler> = {};
for (const capability of CONNECTOR_CAPABILITIES) {
  // `analytics.fetch_sessions` → `int.analytics_fetch_sessions`
  const name = `int.${capability.replace(".", "_")}`;
  generated[name] = capabilityNode(capability);
}

export const integrationNodes: Record<string, NodeHandler> = {
  ...generated,
  // Guarded overrides. These replace the generic node for the three
  // capabilities whose misuse is unrecoverable.
  "int.email_send_approved_message": emailSendApproved,
  "int.cms_publish_approved_asset": cmsPublishApproved,
  "int.billing_create_invoice": billingCreateInvoice,
};
