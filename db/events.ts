/**
 * All SQL for the domain event bus. Nothing outside this module touches
 * domain_events / event_subscriptions / event_delivery_attempts.
 *
 * Tenant note: `pendingDeliveries` is the one cross-client read in this file
 * and it exists solely for the worker. The tenant check happens at delivery
 * time (lib/events/bus.ts), where a mismatch is a hard failure rather than a
 * filtered-out row — a silently skipped cross-tenant event would hide a bug.
 */
import { sql, type TransactionSql } from "@/db/client";
import type {
  DeliveryAttempt,
  DomainEvent,
  EventFilter,
  EventSubscription,
} from "@/lib/events/types";

type Tx = TransactionSql | typeof sql;

function toEvent(row: Record<string, unknown>): DomainEvent {
  return {
    id: row.id as string,
    type: row.type as string,
    version: Number(row.version ?? 1),
    occurredAt: (row.occurredAt as Date).toISOString(),
    projectId: (row.projectId as string | null) ?? null,
    actorId: (row.actorUserId as string | null) ?? null,
    correlationId: row.correlationId as string,
    causationId: (row.causationId as string | null) ?? null,
    workflowRunId: (row.workflowRunId as string | null) ?? null,
    nodeRunId: (row.nodeRunId as string | null) ?? null,
    source: row.source as DomainEvent["source"],
    payload: (row.payload as Record<string, unknown>) ?? {},
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    dedupeKey: (row.dedupeKey as string | null) ?? null,
  };
}

/**
 * Insert an event. Returns `created: false` when a dedupe key collided — the
 * caller learns the event already exists rather than getting a duplicate or an
 * exception.
 */
export async function insertEvent(
  tx: Tx,
  args: {
    type: string;
    version: number;
    projectId: string | null;
    actorId: string | null;
    correlationId: string;
    causationId: string | null;
    workflowRunId: string | null;
    nodeRunId: string | null;
    source: string;
    payload: Record<string, unknown>;
    metadata: Record<string, unknown>;
    dedupeKey: string | null;
  }
): Promise<{ event: DomainEvent; created: boolean }> {
  const [row] = await tx`
    insert into domain_events (
      type, version, project_id, actor_user_id, correlation_id, causation_id,
      workflow_run_id, node_run_id, source, payload, metadata, dedupe_key
    ) values (
      ${args.type}, ${args.version}, ${args.projectId}, ${args.actorId},
      ${args.correlationId}, ${args.causationId}, ${args.workflowRunId},
      ${args.nodeRunId}, ${args.source}, ${tx.json(args.payload as never)},
      ${tx.json(args.metadata as never)}, ${args.dedupeKey}
    )
    on conflict do nothing
    returning *
  `;
  if (row) return { event: toEvent(row), created: true };

  const [existing] = await tx`
    select * from domain_events where dedupe_key = ${args.dedupeKey}
  `;
  if (!existing) {
    // No dedupe key and still no row: the insert genuinely failed.
    throw new Error(`Event ${args.type} could not be written.`);
  }
  return { event: toEvent(existing), created: false };
}

export async function getEvent(eventId: string): Promise<DomainEvent | null> {
  const [row] = await sql`select * from domain_events where id = ${eventId}`;
  return row ? toEvent(row) : null;
}

export async function listEvents(filters: {
  projectId?: string | null;
  type?: string;
  correlationId?: string;
  limit?: number;
}): Promise<DomainEvent[]> {
  const limit = Math.min(filters.limit ?? 100, 500);
  const rows = await sql`
    select * from domain_events
    where (${filters.projectId ?? null}::uuid is null or project_id = ${filters.projectId ?? null})
      and (${filters.type ?? null}::text is null or type = ${filters.type ?? null})
      and (${filters.correlationId ?? null}::uuid is null
           or correlation_id = ${filters.correlationId ?? null})
    order by occurred_at desc
    limit ${limit}
  `;
  return rows.map(toEvent);
}

// ------------------------------------------------------------ subscriptions

function toSubscription(row: Record<string, unknown>): EventSubscription {
  return {
    id: row.id as string,
    eventType: row.eventType as string,
    workflowKey: row.workflowKey as string,
    projectId: (row.projectId as string | null) ?? null,
    filter: (row.filter as EventFilter) ?? { kind: "always" },
    idempotencyTemplate: row.idempotencyTemplate as string,
    autonomyNote: (row.autonomyNote as string) ?? "",
    acceptedVersions: (row.acceptedVersions as number[]) ?? [1],
    enabled: Boolean(row.enabled),
  };
}

export async function upsertSubscription(
  tx: Tx,
  args: {
    eventType: string;
    workflowKey: string;
    projectId: string | null;
    filter: EventFilter;
    idempotencyTemplate: string;
    autonomyNote: string;
    acceptedVersions: number[];
    enabled: boolean;
    createdBy: string | null;
  }
): Promise<string> {
  const [row] = await tx`
    insert into event_subscriptions (
      event_type, workflow_key, project_id, filter, idempotency_template,
      autonomy_note, accepted_versions, enabled, created_by
    ) values (
      ${args.eventType}, ${args.workflowKey}, ${args.projectId},
      ${tx.json(args.filter as never)}, ${args.idempotencyTemplate},
      ${args.autonomyNote}, ${args.acceptedVersions}, ${args.enabled}, ${args.createdBy}
    )
    on conflict (event_type, workflow_key,
      coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid))
    do update set
      filter = excluded.filter,
      idempotency_template = excluded.idempotency_template,
      autonomy_note = excluded.autonomy_note,
      accepted_versions = excluded.accepted_versions,
      enabled = excluded.enabled
    returning id
  `;
  return row!.id as string;
}

export async function subscriptionsFor(
  tx: Tx,
  eventType: string,
  projectId: string | null
): Promise<EventSubscription[]> {
  const rows = await tx`
    select * from event_subscriptions
    where event_type = ${eventType} and enabled
      and (project_id is null or project_id = ${projectId})
  `;
  return rows.map(toSubscription);
}

export async function listSubscriptions(): Promise<EventSubscription[]> {
  const rows = await sql`select * from event_subscriptions order by event_type, workflow_key`;
  return rows.map(toSubscription);
}

// ---------------------------------------------------------------- delivery

function toAttempt(row: Record<string, unknown>): DeliveryAttempt {
  return {
    id: row.id as string,
    eventId: row.eventId as string,
    subscriptionId: row.subscriptionId as string,
    status: row.status as DeliveryAttempt["status"],
    attempts: Number(row.attempts ?? 0),
    workflowRunId: (row.workflowRunId as string | null) ?? null,
    lastError: (row.lastError as string | null) ?? null,
    deadLetteredAt: (row.deadLetteredAt as Date | null) ?? null,
  };
}

/**
 * Create the pending attempt row, or return null when one already exists.
 * The unique (event_id, subscription_id) index makes this the idempotent-
 * consumption point: a redelivered event cannot start a second run.
 */
export async function claimDelivery(
  tx: Tx,
  eventId: string,
  subscriptionId: string
): Promise<DeliveryAttempt | null> {
  const [row] = await tx`
    insert into event_delivery_attempts (event_id, subscription_id, status, attempts)
    values (${eventId}, ${subscriptionId}, 'pending', 1)
    on conflict (event_id, subscription_id) do update set
      attempts = event_delivery_attempts.attempts + 1,
      updated_at = now()
    where event_delivery_attempts.status in ('pending', 'failed')
      and (event_delivery_attempts.next_attempt_at is null
           or event_delivery_attempts.next_attempt_at <= now())
    returning *
  `;
  return row ? toAttempt(row) : null;
}

export async function settleDelivery(
  tx: Tx,
  args: {
    attemptId: string;
    status: DeliveryAttempt["status"];
    workflowRunId?: string | null;
    error?: string | null;
    retryInSeconds?: number | null;
  }
): Promise<void> {
  await tx`
    update event_delivery_attempts set
      status = ${args.status},
      workflow_run_id = ${args.workflowRunId ?? null},
      last_error = ${args.error ?? null},
      next_attempt_at = ${
        args.retryInSeconds
          ? sql`now() + make_interval(secs => ${args.retryInSeconds})`
          : sql`next_attempt_at`
      },
      dead_lettered_at = ${args.status === "dead_lettered" ? sql`now()` : sql`dead_lettered_at`},
      updated_at = now()
    where id = ${args.attemptId}
  `;
}

/** Events with at least one subscription that has not been delivered yet. */
export async function undeliveredEventIds(limit = 50): Promise<string[]> {
  const rows = await sql`
    select distinct e.id
    from domain_events e
    join event_subscriptions s
      on s.event_type = e.type and s.enabled
      and (s.project_id is null or s.project_id = e.project_id)
    left join event_delivery_attempts a
      on a.event_id = e.id and a.subscription_id = s.id
    where a.id is null
       or (a.status = 'failed'
           and (a.next_attempt_at is null or a.next_attempt_at <= now()))
    order by e.id
    limit ${limit}
  `;
  return rows.map((r) => r.id as string);
}

export async function listDeadLetters(limit = 100): Promise<
  (DeliveryAttempt & { eventType: string; workflowKey: string; projectId: string | null })[]
> {
  const rows = await sql`
    select a.*, e.type as event_type, e.project_id, s.workflow_key
    from event_delivery_attempts a
    join domain_events e on e.id = a.event_id
    join event_subscriptions s on s.id = a.subscription_id
    where a.status = 'dead_lettered'
    order by a.dead_lettered_at desc
    limit ${limit}
  `;
  return rows.map((r) => ({
    ...toAttempt(r),
    eventType: r.eventType as string,
    workflowKey: r.workflowKey as string,
    projectId: (r.projectId as string | null) ?? null,
  }));
}

/** Re-arm a dead letter so the next dispatch retries it. Operator action. */
export async function replayDelivery(tx: Tx, attemptId: string): Promise<boolean> {
  const rows = await tx`
    update event_delivery_attempts set
      status = 'pending', attempts = 0, next_attempt_at = null,
      dead_lettered_at = null, last_error = null, updated_at = now()
    where id = ${attemptId} and status = 'dead_lettered'
    returning id
  `;
  return rows.length > 0;
}

export interface EventTypeStats {
  type: string;
  published: number;
  delivered: number;
  deadLettered: number;
  lastAt: Date | null;
}

export async function eventStats(limit = 50): Promise<EventTypeStats[]> {
  const rows = await sql`
    select e.type,
      count(distinct e.id)::int as published,
      count(distinct a.id) filter (where a.status = 'delivered')::int as delivered,
      count(distinct a.id) filter (where a.status = 'dead_lettered')::int as dead_lettered,
      max(e.occurred_at) as last_at
    from domain_events e
    left join event_delivery_attempts a on a.event_id = e.id
    group by e.type
    order by max(e.occurred_at) desc
    limit ${limit}
  `;
  return rows.map((r) => ({
    type: r.type as string,
    published: Number(r.published),
    delivered: Number(r.delivered),
    deadLettered: Number(r.deadLettered),
    lastAt: (r.lastAt as Date | null) ?? null,
  }));
}
