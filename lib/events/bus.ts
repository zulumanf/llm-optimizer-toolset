/**
 * The domain event bus.
 *
 * The load-bearing design decision is that `publishEvent` takes the caller's
 * transaction. An event and the state change that caused it therefore commit
 * together: an event cannot exist for a write that rolled back, and a write
 * cannot commit without its event. That is why the bus lives in Postgres and
 * not in a broker — no outbox, no dual write, no reconciliation job.
 *
 * Delivery is at-least-once with idempotent consumption. The unique
 * (event_id, subscription_id) index is the guarantee; a redelivered event
 * cannot start a second workflow run.
 */
import { randomUUID } from "node:crypto";
import { sql, type TransactionSql } from "@/db/client";
import { enqueueJob } from "@/db/jobs";
import * as store from "@/db/events";
import { eventDefinition } from "@/lib/events/catalog";
import { matchesFilter, renderIdempotencyKey } from "@/lib/events/filter";
import { MAX_DELIVERY_ATTEMPTS, type DomainEvent, type PublishEventInput } from "@/lib/events/types";
import { ClassifiedError } from "@/lib/errors";
import { log } from "@/lib/logger";
import { raiseException } from "@/lib/workflow/exceptions";

type Tx = TransactionSql | typeof sql;

/**
 * Publish a domain event inside the caller's transaction.
 *
 * Refuses an unknown type or an invalid payload — a bus that accepts anything
 * is a log, and a log cannot start work safely.
 */
export async function publishEvent<TPayload extends Record<string, unknown>>(
  tx: Tx,
  input: PublishEventInput<TPayload>
): Promise<{ event: DomainEvent; created: boolean }> {
  const definition = eventDefinition(input.type);
  if (!definition) {
    throw new ClassifiedError(
      "validation",
      `Unknown domain event type "${input.type}". Declare it in lib/events/catalog.ts first.`
    );
  }
  const version = input.version ?? definition.version;
  const parsed = definition.schema.safeParse(input.payload);
  if (!parsed.success) {
    throw new ClassifiedError(
      "validation",
      `Payload for "${input.type}" is invalid: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`
    );
  }
  const projectId = input.projectId ?? null;
  if (definition.requiresProject && projectId === null) {
    throw new ClassifiedError(
      "validation",
      `Event "${input.type}" is client-scoped and requires a projectId.`
    );
  }

  const result = await store.insertEvent(tx, {
    type: input.type,
    version,
    projectId,
    actorId: input.actorId ?? null,
    correlationId: input.correlationId ?? randomUUID(),
    causationId: input.causationId ?? null,
    workflowRunId: input.workflowRunId ?? null,
    nodeRunId: input.nodeRunId ?? null,
    source: input.source ?? "service",
    payload: parsed.data as Record<string, unknown>,
    metadata: input.metadata ?? {},
    dedupeKey: input.dedupeKey ?? null,
  });

  if (result.created) {
    await enqueueJob(tx, "deliver_events", { eventId: result.event.id });
    log("info", "event.published", {
      type: input.type,
      version,
      eventId: result.event.id,
      projectId,
    });
  } else {
    log("info", "event.deduplicated", { type: input.type, dedupeKey: input.dedupeKey });
  }
  return result;
}

/** Convenience: publish outside an existing transaction. */
export async function publishEventStandalone<TPayload extends Record<string, unknown>>(
  input: PublishEventInput<TPayload>
): Promise<{ event: DomainEvent; created: boolean }> {
  return sql.begin((tx) => publishEvent(tx, input));
}

// ---------------------------------------------------------------- delivery

export interface DeliveryOutcome {
  subscriptionId: string;
  status: "delivered" | "skipped" | "failed" | "dead_lettered" | "already_handled";
  workflowRunId?: string;
  error?: string;
}

/**
 * Deliver one event to every matching subscription.
 *
 * `startWorkflow` is injected rather than imported so this module does not
 * depend on the automation runtime — the runtime depends on the bus, and a
 * cycle between them would make both untestable.
 */
export async function deliverEvent(
  eventId: string,
  startWorkflow: (args: {
    workflowKey: string;
    projectId: string | null;
    idempotencyKey: string;
    input: Record<string, unknown>;
  }) => Promise<string>
): Promise<DeliveryOutcome[]> {
  const event = await store.getEvent(eventId);
  if (!event) throw new ClassifiedError("not_found", `Event ${eventId} not found.`);

  const subscriptions = await store.subscriptionsFor(sql, event.type, event.projectId);
  const outcomes: DeliveryOutcome[] = [];

  for (const subscription of subscriptions) {
    // Tenant check. A subscription scoped to another client must never see this
    // event — and a mismatch here is a defect, so it fails loudly rather than
    // being quietly filtered.
    if (subscription.projectId !== null && subscription.projectId !== event.projectId) {
      await sql.begin((tx) =>
        raiseException(tx, {
          projectId: event.projectId,
          kind: "failed_workflow",
          severity: "critical",
          summary: `Tenant scope violation: subscription ${subscription.id} matched an event from another client.`,
          recommendedAction: "Treat as a defect — inspect the subscription query before re-enabling delivery.",
        })
      );
      outcomes.push({
        subscriptionId: subscription.id,
        status: "failed",
        error: "tenant scope violation",
      });
      continue;
    }

    if (!subscription.acceptedVersions.includes(event.version)) {
      outcomes.push({ subscriptionId: subscription.id, status: "skipped" });
      continue;
    }

    const attempt = await sql.begin((tx) => store.claimDelivery(tx, event.id, subscription.id));
    if (!attempt) {
      // Already delivered, or backing off. Either way this call does nothing —
      // which is precisely what idempotent consumption means.
      outcomes.push({ subscriptionId: subscription.id, status: "already_handled" });
      continue;
    }

    if (!matchesFilter(subscription.filter, event.payload)) {
      await sql.begin((tx) =>
        store.settleDelivery(tx, { attemptId: attempt.id, status: "skipped" })
      );
      outcomes.push({ subscriptionId: subscription.id, status: "skipped" });
      continue;
    }

    try {
      const idempotencyKey = renderIdempotencyKey(subscription.idempotencyTemplate, event);
      const runId = await startWorkflow({
        workflowKey: subscription.workflowKey,
        projectId: event.projectId,
        idempotencyKey,
        input: {
          event: {
            id: event.id,
            type: event.type,
            version: event.version,
            correlationId: event.correlationId,
            occurredAt: event.occurredAt,
          },
          payload: event.payload,
        },
      });
      await sql.begin((tx) =>
        store.settleDelivery(tx, {
          attemptId: attempt.id,
          status: "delivered",
          workflowRunId: runId,
        })
      );
      outcomes.push({ subscriptionId: subscription.id, status: "delivered", workflowRunId: runId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const exhausted = attempt.attempts >= MAX_DELIVERY_ATTEMPTS;
      await sql.begin(async (tx) => {
        await store.settleDelivery(tx, {
          attemptId: attempt.id,
          status: exhausted ? "dead_lettered" : "failed",
          error: message.slice(0, 500),
          retryInSeconds: exhausted ? null : 30 * 2 ** (attempt.attempts - 1),
        });
        if (exhausted) {
          await raiseException(tx, {
            projectId: event.projectId,
            kind: "failed_workflow",
            severity: "high",
            summary: `Event ${event.type} could not start ${subscription.workflowKey} after ${MAX_DELIVERY_ATTEMPTS} attempts.`,
            detail: { eventId: event.id, error: message.slice(0, 500) },
            recommendedAction: "Fix the cause, then replay the dead-lettered delivery.",
          });
        }
      });
      log("warn", "event.delivery_failed", {
        eventId: event.id,
        subscriptionId: subscription.id,
        attempts: attempt.attempts,
        deadLettered: exhausted,
      });
      outcomes.push({
        subscriptionId: subscription.id,
        status: exhausted ? "dead_lettered" : "failed",
        error: message,
      });
    }
  }

  return outcomes;
}
