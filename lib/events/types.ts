/**
 * Domain event types (spec: domain-event-and-trigger-system).
 *
 * The envelope is deliberately the same shape the request asked for. What
 * matters more than the shape is what is NOT optional: a type, a version, a
 * correlation id and a source. An event whose provenance cannot be traced is
 * not evidence, and this platform's events are evidence.
 */

export type EventSource = "trigger" | "workflow" | "webhook" | "service" | "manual";

export interface DomainEvent<TPayload = Record<string, unknown>> {
  id: string;
  type: string;
  version: number;
  occurredAt: string;

  /** Tenant key. Null = platform-scoped (no client involved). */
  projectId: string | null;
  actorId: string | null;

  /** Root of the causal chain. */
  correlationId: string;
  /** The event that directly caused this one. */
  causationId: string | null;
  workflowRunId: string | null;
  nodeRunId: string | null;

  source: EventSource;
  payload: TPayload;
  metadata: Record<string, unknown>;
  dedupeKey: string | null;
}

export interface PublishEventInput<TPayload = Record<string, unknown>> {
  type: string;
  version?: number;
  projectId?: string | null;
  actorId?: string | null;
  correlationId?: string;
  causationId?: string | null;
  workflowRunId?: string | null;
  nodeRunId?: string | null;
  source?: EventSource;
  payload: TPayload;
  metadata?: Record<string, unknown>;
  /**
   * Natural key for exactly-once publication. A producer that can compute one
   * ("claim.expired:<claimId>") gets deduplication for free.
   */
  dedupeKey?: string | null;
}

/**
 * A subscription filter. Data, never an expression — the same decision spec 018
 * made for edge conditions, for the same reason: a filter that must be stored,
 * diffed and reasoned about cannot be a string someone evals.
 */
export type EventFilter =
  | { kind: "always" }
  | { kind: "payload_equals"; path: string; value: string | number | boolean }
  | { kind: "payload_gte"; path: string; value: number }
  | { kind: "payload_lt"; path: string; value: number }
  | { kind: "payload_truthy"; path: string };

export interface EventSubscription {
  id: string;
  eventType: string;
  workflowKey: string;
  projectId: string | null;
  filter: EventFilter;
  idempotencyTemplate: string;
  autonomyNote: string;
  acceptedVersions: number[];
  enabled: boolean;
}

export type DeliveryStatus =
  | "pending"
  | "delivered"
  | "skipped"
  | "failed"
  | "dead_lettered";

export interface DeliveryAttempt {
  id: string;
  eventId: string;
  subscriptionId: string;
  status: DeliveryStatus;
  attempts: number;
  workflowRunId: string | null;
  lastError: string | null;
  deadLetteredAt: Date | null;
}

/** Max delivery attempts before a subscription's delivery is dead-lettered. */
export const MAX_DELIVERY_ATTEMPTS = 3;
