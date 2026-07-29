"use server";

/**
 * Server actions for the graph control plane (spec 018).
 *
 * Every mutation here is a *human* act — starting a run, deciding an approval,
 * cancelling, retrying, resolving an exception. The engine performs its own
 * writes from the worker; nothing in this file is called by an agent.
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import * as store from "@/db/workflow";
import { getCurrentUser, assertRole } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { firstZodMessage } from "@/lib/service-helpers";
import {
  startWorkflow,
  resumeWorkflow,
  cancelWorkflow,
  retryNode,
} from "@/lib/workflow/engine";
import { resolveException } from "@/lib/workflow/exceptions";
import { bootstrapWorkflows } from "@/lib/workflow/templates";

const startSchema = z.object({
  definitionKey: z.string().min(1),
  projectId: z.string().uuid().nullable().optional(),
  input: z.record(z.unknown()).default({}),
  /** Supplied by the caller so a double-submit collapses onto one run. */
  idempotencyKey: z.string().min(8).max(200),
  costCapMicroUsd: z.number().int().positive().optional(),
});

export async function startWorkflowAction(
  raw: unknown
): Promise<ActionResult<{ runId: string; state: string }>> {
  const parsed = startSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  try {
    const user = await getCurrentUser();
    // Definitions live in code; publishing them is cheap and idempotent, and
    // it means a fresh database can start a workflow without a manual step.
    await bootstrapWorkflows();
    const run = await startWorkflow({
      definitionKey: parsed.data.definitionKey,
      projectId: parsed.data.projectId ?? null,
      input: parsed.data.input,
      idempotencyKey: parsed.data.idempotencyKey,
      trigger: "manual",
      startedBy: user.id,
      ...(parsed.data.costCapMicroUsd !== undefined
        ? { costCapMicroUsd: parsed.data.costCapMicroUsd }
        : {}),
    });
    revalidatePath("/workflows");
    return ok({ runId: run.id, state: run.state });
  } catch (err) {
    return fail(err);
  }
}

const decisionSchema = z.object({
  approvalId: z.string().uuid(),
  decision: z.enum(["approved", "rejected"]),
  rationale: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(1, "A rationale is required — an approval without one is not evidence.").max(2000)),
});

/**
 * Decide an approval and resume the paused workflow. The decision row is
 * immutable once written; the signal is what lets the durable wait continue.
 */
export async function decideApprovalAction(
  raw: unknown
): Promise<ActionResult<{ runId: string }>> {
  const parsed = decisionSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  try {
    const user = await getCurrentUser();
    const [approval] = await sql`
      select required_role, decision from workflow_approvals
      where id = ${parsed.data.approvalId}
    `;
    if (!approval) return fail(new ClassifiedError("not_found", "Approval not found."));
    if (approval.decision) {
      return fail(
        new ClassifiedError("conflict", "This approval has already been decided.")
      );
    }
    if (approval.requiredRole === "admin") assertRole(user, "admin");

    const decided = await sql.begin(async (tx) => {
      const result = await store.decideApproval(tx, {
        approvalId: parsed.data.approvalId,
        decision: parsed.data.decision,
        decidedBy: user.id,
        rationale: parsed.data.rationale,
      });
      if (!result) return null;
      await writeAudit(tx, {
        userId: user.id,
        action: `workflow.approval.${parsed.data.decision}`,
        entity: "workflow_approval",
        entityId: parsed.data.approvalId,
        detail: { rationale: parsed.data.rationale },
      });
      return result;
    });
    if (!decided) {
      return fail(new ClassifiedError("conflict", "This approval was decided by someone else."));
    }

    await resumeWorkflow(decided.runId, {
      kind: "approval_decision",
      nodeRunId: decided.nodeRunId,
      payload: { decision: parsed.data.decision, rationale: parsed.data.rationale },
      sentBy: user.id,
    });
    revalidatePath("/control-tower");
    revalidatePath(`/workflows/${decided.runId}`);
    return ok({ runId: decided.runId });
  } catch (err) {
    return fail(err);
  }
}

const cancelSchema = z.object({
  runId: z.string().uuid(),
  reason: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(1, "Say why — a cancelled run without a reason is unexplainable later.").max(500)),
});

export async function cancelWorkflowAction(
  raw: unknown
): Promise<ActionResult<{ runId: string }>> {
  const parsed = cancelSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  try {
    const user = await getCurrentUser();
    await cancelWorkflow(parsed.data.runId, parsed.data.reason, user.id);
    revalidatePath(`/workflows/${parsed.data.runId}`);
    return ok({ runId: parsed.data.runId });
  } catch (err) {
    return fail(err);
  }
}

export async function retryNodeAction(
  raw: unknown
): Promise<ActionResult<{ nodeRunId: string }>> {
  const parsed = z.object({ nodeRunId: z.string().uuid() }).safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "Invalid node run id."));
  }
  try {
    const user = await getCurrentUser();
    await retryNode(parsed.data.nodeRunId, user.id);
    revalidatePath("/workflows");
    return ok({ nodeRunId: parsed.data.nodeRunId });
  } catch (err) {
    return fail(err);
  }
}

const resolveSchema = z.object({
  exceptionId: z.string().uuid(),
  status: z.enum(["resolved", "dismissed"]),
  resolution: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(1, "Record what you did about it.").max(1000)),
});

export async function resolveExceptionAction(
  raw: unknown
): Promise<ActionResult<{ exceptionId: string }>> {
  const parsed = resolveSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  try {
    const user = await getCurrentUser();
    const changed = await sql.begin(async (tx) => {
      const done = await resolveException(tx, {
        id: parsed.data.exceptionId,
        status: parsed.data.status,
        resolution: parsed.data.resolution,
        userId: user.id,
      });
      if (done) {
        await writeAudit(tx, {
          userId: user.id,
          action: `workflow.exception.${parsed.data.status}`,
          entity: "workflow_exception",
          entityId: parsed.data.exceptionId,
          detail: { resolution: parsed.data.resolution },
        });
      }
      return done;
    });
    if (!changed) {
      return fail(new ClassifiedError("conflict", "That exception is no longer open."));
    }
    revalidatePath("/control-tower");
    return ok({ exceptionId: parsed.data.exceptionId });
  } catch (err) {
    return fail(err);
  }
}
