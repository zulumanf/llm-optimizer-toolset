/**
 * The dispatch seam.
 *
 * `lib/triggers` and `lib/events` both need to start a workflow, and neither may
 * import the runtime (the runtime imports them; a cycle would make all three
 * untestable). This module owns the one adapter function both use, and it is the
 * only place that knows how a trigger's or an event's intent becomes a run.
 */
import { bootstrapAutomation } from "@/lib/automation/workflows";
import { startWorkflow } from "@/lib/automation/runtime";
import { dispatchDueTriggers, type WorkflowStarter } from "@/lib/triggers/service";
import { deliverEvent } from "@/lib/events/bus";
import { undeliveredEventIds } from "@/db/events";
import { log } from "@/lib/logger";

/**
 * Start a workflow on behalf of a trigger or an event. Trigger-initiated runs
 * are always `live`: a test run is an explicitly human act, never something a
 * schedule decides.
 */
export const startFromTrigger: WorkflowStarter = async (args) => {
  const run = await startWorkflow({
    workflowKey: args.workflowKey,
    projectId: args.projectId,
    idempotencyKey: args.idempotencyKey,
    input: args.input,
    mode: "live",
    trigger: args.trigger === "manual" ? "manual" : "scheduled",
  });
  return run.id;
};

/** The same adapter, shaped for the event bus. */
export async function startFromEvent(args: {
  workflowKey: string;
  projectId: string | null;
  idempotencyKey: string;
  input: Record<string, unknown>;
}): Promise<string> {
  const run = await startWorkflow({
    workflowKey: args.workflowKey,
    projectId: args.projectId,
    idempotencyKey: args.idempotencyKey,
    input: args.input,
    mode: "live",
    trigger: "signal",
  });
  return run.id;
}

let bootstrapped = false;

/**
 * Ensure definitions and handlers are loaded in this process. Every entry point
 * (worker, cron route, webhook route, server action) calls this first — a run
 * cannot advance through a graph whose handlers are unknown.
 */
export async function ensureAutomationReady(): Promise<void> {
  if (bootstrapped) return;
  const result = await bootstrapAutomation();
  bootstrapped = true;
  if (result.errors.length > 0) {
    log("error", "automation.bootstrap_errors", { errors: result.errors });
  }
}

/** Fire every due schedule and threshold trigger. Safe at any frequency. */
export async function runTriggerDispatch(now: Date = new Date()) {
  await ensureAutomationReady();
  return dispatchDueTriggers(startFromTrigger, now);
}

/** Deliver a batch of undelivered events. Driven by the queue and by cron. */
export async function runEventDelivery(limit = 50): Promise<{
  events: number;
  delivered: number;
  deadLettered: number;
}> {
  await ensureAutomationReady();
  const eventIds = await undeliveredEventIds(limit);
  let delivered = 0;
  let deadLettered = 0;

  for (const eventId of eventIds) {
    const outcomes = await deliverEvent(eventId, startFromEvent);
    delivered += outcomes.filter((o) => o.status === "delivered").length;
    deadLettered += outcomes.filter((o) => o.status === "dead_lettered").length;
  }
  return { events: eventIds.length, delivered, deadLettered };
}

/** Deliver one specific event. The `deliver_events` job handler. */
export async function deliverOneEvent(eventId: string): Promise<void> {
  await ensureAutomationReady();
  await deliverEvent(eventId, startFromEvent);
}
