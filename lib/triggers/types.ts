/** Trigger declarations (spec: domain-event-and-trigger-system). Pure types. */

export const TRIGGER_KINDS = [
  "schedule",
  "webhook",
  "domain_event",
  "threshold",
  "manual",
] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

/**
 * What happens when the dispatcher was down across one or more windows.
 * `run_once` is the default because a client wants the report, once, not five
 * copies of it — and not silence either.
 */
export type MissedRunPolicy = "skip" | "run_once" | "run_all";

export type ThresholdComparison = "gt" | "gte" | "lt" | "lte";

export interface AutomationTrigger {
  id: string;
  key: string;
  kind: TriggerKind;
  workflowKey: string;
  projectId: string | null;
  name: string;
  description: string;
  enabled: boolean;
  config: Record<string, unknown>;

  cron: string | null;
  timezone: string;
  startsAt: Date | null;
  endsAt: Date | null;
  missedRunPolicy: MissedRunPolicy;
  nextRunAt: Date | null;
  lastFiredAt: Date | null;
  lastFireKey: string | null;

  metricKey: string | null;
  comparison: ThresholdComparison | null;
  thresholdValue: number | null;
  lookbackDays: number | null;
  minimumSample: number | null;
  lastBreached: boolean;
}

export type FireOutcome =
  | "fired"
  | "skipped_missed"
  | "suppressed"
  | "insufficient_sample"
  | "failed";

export interface TriggerFire {
  id: string;
  triggerId: string;
  fireKey: string;
  firedAt: Date;
  workflowRunId: string | null;
  eventId: string | null;
  outcome: FireOutcome;
  detail: Record<string, unknown>;
}

export interface CreateTriggerInput {
  key: string;
  kind: TriggerKind;
  workflowKey: string;
  projectId?: string | null;
  name?: string;
  description?: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
  cron?: string | null;
  timezone?: string;
  startsAt?: Date | null;
  endsAt?: Date | null;
  missedRunPolicy?: MissedRunPolicy;
  metricKey?: string | null;
  comparison?: ThresholdComparison | null;
  thresholdValue?: number | null;
  lookbackDays?: number | null;
  minimumSample?: number | null;
  createdBy?: string | null;
}

export interface WebhookEndpoint {
  id: string;
  slug: string;
  provider: string;
  projectId: string | null;
  triggerId: string | null;
  signatureScheme: "hmac_sha256" | "stripe" | "none";
  eventType: string;
  enabled: boolean;
  rateLimitPerMinute: number;
  revokedAt: Date | null;
}

export type WebhookReceiptStatus =
  | "accepted"
  | "duplicate"
  | "rejected_signature"
  | "rejected_schema"
  | "rejected_rate_limit"
  | "rejected_disabled";
