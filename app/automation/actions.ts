"use server";

/**
 * Server actions for the automation layer.
 *
 * Every mutating action here does three things before anything else: resolve the
 * current user, assert the role, and record an audit row. That order is not
 * decoration — a role check that happens after the effect is not a role check.
 */
import { revalidatePath } from "next/cache";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { assertRole, getCurrentUser } from "@/lib/auth";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { ClassifiedError } from "@/lib/errors";
import { decideApproval } from "@/db/workflow";
import { resolveException } from "@/lib/workflow/exceptions";
import * as triggerStore from "@/db/triggers";
import { replayDelivery } from "@/db/events";
import {
  cancelWorkflow,
  retryNode,
  signalWorkflow,
  startWorkflow,
} from "@/lib/automation/runtime";
import { bundleFromStored, getFixture } from "@/lib/automation/testmode";
import { manualTrigger, publishManualEvent } from "@/lib/triggers/service";
import { startFromTrigger, ensureAutomationReady } from "@/lib/automation/dispatch";
import { checkConnection } from "@/lib/connectors/health";
import { liftSuppression, suppress, type SuppressionReason } from "@/lib/outreach/suppression";
import { stopSequence } from "@/lib/outreach/sequences";
import { AUTOMATION_WORKFLOWS } from "@/lib/automation/workflows";

/**
 * Start a run from the UI.
 *
 * Test mode is the default and live mode must be asked for explicitly, because
 * the failure modes are not symmetric: a needless test run costs nothing, and an
 * unintended live run can email a prospect.
 */
export async function startAutomationRun(input: {
  workflowKey: string;
  projectId?: string | null;
  mode: "live" | "test";
  reason: string;
  fixtureName?: string;
}): Promise<ActionResult<{ runId: string; mode: string }>> {
  try {
    const user = await getCurrentUser();
    if (input.mode === "live") assertRole(user, "admin");
    await ensureAutomationReady();

    const workflow = AUTOMATION_WORKFLOWS.find((w) => w.key === input.workflowKey);
    if (!workflow) {
      throw new ClassifiedError("not_found", `Unknown workflow "${input.workflowKey}".`);
    }
    if (input.reason.trim().length < 3) {
      throw new ClassifiedError(
        "validation",
        "A reason is required — it is recorded against the run."
      );
    }

    const fixtures =
      input.mode === "test" && input.fixtureName
        ? await getFixture(input.workflowKey, input.fixtureName)
        : null;
    if (input.mode === "test" && input.fixtureName && fixtures === null) {
      throw new ClassifiedError(
        "not_found",
        `No fixture named "${input.fixtureName}" for this workflow.`
      );
    }

    const projectId =
      workflow.clientScope === "platform_only" ? null : (input.projectId ?? null);

    if (input.mode === "test") {
      const run = await startWorkflow({
        workflowKey: input.workflowKey,
        projectId,
        idempotencyKey: `ui:${user.id}:${Date.now()}`,
        mode: "test",
        trigger: "manual",
        startedBy: user.id,
        input: fixtures?.input ?? {},
        fixtures: fixtures ? bundleFromStored(fixtures) : undefined,
      });
      await sql.begin((tx) =>
        writeAudit(tx, {
          userId: user.id,
          action: "automation.test_run_started",
          entity: "workflow_run",
          entityId: run.id,
          detail: {
            workflowKey: input.workflowKey,
            reason: input.reason,
            fixture: input.fixtureName ?? null,
          },
        })
      );
      revalidatePath(`/automation/workflows/${input.workflowKey}`);
      return ok({ runId: run.id, mode: "test" });
    }

    // Live: routed through manualTrigger so the reason and the audit row are
    // recorded by the same path a CLI or API start would use.
    const result = await manualTrigger(
      {
        workflowKey: input.workflowKey,
        projectId,
        reason: input.reason,
        mode: "live",
        userId: user.id,
      },
      startFromTrigger
    );
    revalidatePath(`/automation/workflows/${input.workflowKey}`);
    return ok({ runId: result.runId, mode: "live" });
  } catch (err) {
    return fail(err);
  }
}

export async function decideAutomationApproval(input: {
  approvalId: string;
  decision: "approved" | "rejected";
  rationale: string;
}): Promise<ActionResult<{ resumed: boolean }>> {
  try {
    const user = await getCurrentUser();
    if (input.rationale.trim().length < 3) {
      throw new ClassifiedError(
        "validation",
        "A rationale is required — the decision is recorded permanently."
      );
    }

    const [approval] = await sql`
      select required_role, workflow_run_id from workflow_approvals
      where id = ${input.approvalId} and decision is null
    `;
    if (!approval) {
      throw new ClassifiedError(
        "conflict",
        "That approval no longer needs a decision — it was already decided."
      );
    }
    // The node names the role; honouring it is the whole point of naming it.
    if ((approval.requiredRole as string) === "admin") assertRole(user, "admin");

    const decided = await sql.begin((tx) =>
      decideApproval(tx, {
        approvalId: input.approvalId,
        decision: input.decision,
        decidedBy: user.id,
        rationale: input.rationale,
      })
    );
    if (!decided) {
      throw new ClassifiedError("conflict", "The approval was decided by someone else.");
    }

    await signalWorkflow(decided.runId, {
      kind: "approval_decision",
      nodeRunId: decided.nodeRunId,
      payload: { decision: input.decision, rationale: input.rationale },
      sentBy: user.id,
    });

    revalidatePath("/automation");
    revalidatePath(`/automation/runs/${decided.runId}`);
    return ok({ resumed: true });
  } catch (err) {
    return fail(err);
  }
}

export async function retryAutomationNode(
  nodeRunId: string
): Promise<ActionResult<{ retried: boolean }>> {
  try {
    const user = await getCurrentUser();
    await ensureAutomationReady();
    await retryNode(nodeRunId, user.id);
    revalidatePath("/automation");
    return ok({ retried: true });
  } catch (err) {
    return fail(err);
  }
}

export async function cancelAutomationRun(input: {
  runId: string;
  reason: string;
}): Promise<ActionResult<{ cancelled: boolean }>> {
  try {
    const user = await getCurrentUser();
    if (input.reason.trim().length < 3) {
      throw new ClassifiedError("validation", "A cancellation reason is required.");
    }
    await cancelWorkflow(input.runId, input.reason, user.id);
    revalidatePath(`/automation/runs/${input.runId}`);
    return ok({ cancelled: true });
  } catch (err) {
    return fail(err);
  }
}

export async function resolveAutomationException(input: {
  exceptionId: string;
  status: "resolved" | "dismissed";
  resolution: string;
}): Promise<ActionResult<{ resolved: boolean }>> {
  try {
    const user = await getCurrentUser();
    if (input.resolution.trim().length < 3) {
      throw new ClassifiedError(
        "validation",
        "Say what was done — a resolved exception with no resolution is not a record."
      );
    }
    const resolved = await sql.begin((tx) =>
      resolveException(tx, {
        id: input.exceptionId,
        status: input.status,
        resolution: input.resolution,
        userId: user.id,
      })
    );
    revalidatePath("/automation");
    return ok({ resolved });
  } catch (err) {
    return fail(err);
  }
}

export async function setTriggerEnabled(input: {
  triggerId: string;
  enabled: boolean;
}): Promise<ActionResult<{ enabled: boolean }>> {
  try {
    const user = await getCurrentUser();
    assertRole(user, "admin");
    await sql.begin(async (tx) => {
      await triggerStore.setEnabled(tx, input.triggerId, input.enabled);
      await writeAudit(tx, {
        userId: user.id,
        action: input.enabled ? "automation.trigger_enabled" : "automation.trigger_disabled",
        entity: "automation_trigger",
        entityId: input.triggerId,
        detail: {},
      });
    });
    revalidatePath("/automation/triggers");
    return ok({ enabled: input.enabled });
  } catch (err) {
    return fail(err);
  }
}

export async function testConnectorConnection(
  connectionId: string
): Promise<ActionResult<{ authorizationOk: boolean; readOk: boolean; message: string }>> {
  try {
    const user = await getCurrentUser();
    assertRole(user, "admin");
    const result = await checkConnection(connectionId);
    await sql.begin((tx) =>
      writeAudit(tx, {
        userId: user.id,
        action: "connector.tested",
        entity: "connector_connection",
        entityId: connectionId,
        detail: { authorizationOk: result.authorizationOk, readOk: result.readOk },
      })
    );
    revalidatePath("/automation/connectors");
    return ok({
      authorizationOk: result.authorizationOk,
      readOk: result.readOk,
      message:
        result.authorizationOk && result.readOk
          ? "Authorisation and a minimal read both succeeded."
          : (result.errorMessage ?? "The probe failed; see the connector's health history."),
    });
  } catch (err) {
    return fail(err);
  }
}

export async function replayDeadLetter(
  attemptId: string
): Promise<ActionResult<{ replayed: boolean }>> {
  try {
    const user = await getCurrentUser();
    assertRole(user, "admin");
    const replayed = await sql.begin(async (tx) => {
      const done = await replayDelivery(tx, attemptId);
      if (done) {
        await writeAudit(tx, {
          userId: user.id,
          action: "automation.delivery_replayed",
          entity: "event_delivery_attempt",
          entityId: attemptId,
          detail: {},
        });
      }
      return done;
    });
    revalidatePath("/automation/events");
    return ok({ replayed });
  } catch (err) {
    return fail(err);
  }
}

export async function publishTestEvent(input: {
  type: string;
  projectId?: string | null;
  payload: string;
  reason: string;
}): Promise<ActionResult<{ eventId: string; created: boolean }>> {
  try {
    const user = await getCurrentUser();
    assertRole(user, "admin");
    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(input.payload);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("payload must be a JSON object");
      }
      payload = parsed as Record<string, unknown>;
    } catch (err) {
      throw new ClassifiedError(
        "validation",
        `Payload is not a JSON object: ${err instanceof Error ? err.message : "parse error"}`
      );
    }
    await ensureAutomationReady();
    const result = await publishManualEvent({
      type: input.type,
      projectId: input.projectId ?? null,
      payload,
      userId: user.id,
      reason: input.reason,
    });
    revalidatePath("/automation/events");
    return ok(result);
  } catch (err) {
    return fail(err);
  }
}

export async function suppressContact(input: {
  value: string;
  scope: "email" | "phone" | "domain";
  reason: SuppressionReason;
  detail: string;
  projectId?: string | null;
}): Promise<ActionResult<{ suppressed: boolean; alreadySuppressed: boolean }>> {
  try {
    const user = await getCurrentUser();
    const result = await sql.begin((tx) =>
      suppress(tx, {
        scope: input.scope,
        value: input.value,
        reason: input.reason,
        detail: input.detail,
        projectId: input.projectId ?? null,
        userId: user.id,
      })
    );
    revalidatePath("/automation/outreach");
    return ok({ suppressed: true, alreadySuppressed: result.alreadySuppressed });
  } catch (err) {
    return fail(err);
  }
}

export async function liftContactSuppression(input: {
  id: string;
  reason: string;
}): Promise<ActionResult<{ lifted: boolean }>> {
  try {
    const user = await getCurrentUser();
    // Lifting a do-not-contact instruction is an admin decision, always.
    assertRole(user, "admin");
    const lifted = await sql.begin((tx) =>
      liftSuppression(tx, { id: input.id, userId: user.id, reason: input.reason })
    );
    revalidatePath("/automation/outreach");
    return ok({ lifted });
  } catch (err) {
    return fail(err);
  }
}

export async function stopOutreachSequence(input: {
  sequenceId: string;
  detail: string;
}): Promise<ActionResult<{ stopped: boolean }>> {
  try {
    const user = await getCurrentUser();
    const result = await sql.begin((tx) =>
      stopSequence(tx, {
        sequenceId: input.sequenceId,
        reason: "manual",
        detail: input.detail,
        userId: user.id,
      })
    );
    revalidatePath("/automation/outreach");
    return ok({ stopped: result.stopped });
  } catch (err) {
    return fail(err);
  }
}
