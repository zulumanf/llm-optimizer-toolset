/**
 * All SQL for triggers, fires, and webhook endpoints/receipts.
 *
 * The two unique indexes this module leans on are the whole idempotency story
 * for "how work starts": `trigger_fires (trigger_id, fire_key)` means a
 * scheduled window fires once no matter how many dispatchers race, and
 * `webhook_receipts (endpoint_id, provider_event_id)` means a replayed webhook
 * is recorded and ignored rather than acted on twice.
 */
import { sql, type TransactionSql } from "@/db/client";
import type {
  AutomationTrigger,
  CreateTriggerInput,
  FireOutcome,
  TriggerFire,
  WebhookEndpoint,
  WebhookReceiptStatus,
} from "@/lib/triggers/types";

type Tx = TransactionSql | typeof sql;

function toTrigger(row: Record<string, unknown>): AutomationTrigger {
  return {
    id: row.id as string,
    key: row.key as string,
    kind: row.kind as AutomationTrigger["kind"],
    workflowKey: row.workflowKey as string,
    projectId: (row.projectId as string | null) ?? null,
    name: (row.name as string) ?? "",
    description: (row.description as string) ?? "",
    enabled: Boolean(row.enabled),
    config: (row.config as Record<string, unknown>) ?? {},
    cron: (row.cron as string | null) ?? null,
    timezone: (row.timezone as string) ?? "UTC",
    startsAt: (row.startsAt as Date | null) ?? null,
    endsAt: (row.endsAt as Date | null) ?? null,
    missedRunPolicy: row.missedRunPolicy as AutomationTrigger["missedRunPolicy"],
    nextRunAt: (row.nextRunAt as Date | null) ?? null,
    lastFiredAt: (row.lastFiredAt as Date | null) ?? null,
    lastFireKey: (row.lastFireKey as string | null) ?? null,
    metricKey: (row.metricKey as string | null) ?? null,
    comparison: (row.comparison as AutomationTrigger["comparison"]) ?? null,
    thresholdValue:
      row.thresholdValue === null || row.thresholdValue === undefined
        ? null
        : Number(row.thresholdValue),
    lookbackDays: row.lookbackDays === null ? null : Number(row.lookbackDays),
    minimumSample: row.minimumSample === null ? null : Number(row.minimumSample),
    lastBreached: Boolean(row.lastBreached),
  };
}

export async function upsertTrigger(
  tx: Tx,
  input: CreateTriggerInput & { nextRunAt?: Date | null }
): Promise<string> {
  const [row] = await tx`
    insert into automation_triggers (
      key, kind, workflow_key, project_id, name, description, enabled, config,
      cron, timezone, starts_at, ends_at, missed_run_policy, next_run_at,
      metric_key, comparison, threshold_value, lookback_days, minimum_sample,
      created_by
    ) values (
      ${input.key}, ${input.kind}, ${input.workflowKey}, ${input.projectId ?? null},
      ${input.name ?? input.key}, ${input.description ?? ""}, ${input.enabled ?? true},
      ${tx.json((input.config ?? {}) as never)}, ${input.cron ?? null},
      ${input.timezone ?? "UTC"}, ${input.startsAt ?? null}, ${input.endsAt ?? null},
      ${input.missedRunPolicy ?? "run_once"}, ${input.nextRunAt ?? null},
      ${input.metricKey ?? null}, ${input.comparison ?? null},
      ${input.thresholdValue ?? null}, ${input.lookbackDays ?? null},
      ${input.minimumSample ?? null}, ${input.createdBy ?? null}
    )
    on conflict (key) do update set
      kind = excluded.kind,
      workflow_key = excluded.workflow_key,
      project_id = excluded.project_id,
      name = excluded.name,
      description = excluded.description,
      enabled = excluded.enabled,
      config = excluded.config,
      cron = excluded.cron,
      timezone = excluded.timezone,
      starts_at = excluded.starts_at,
      ends_at = excluded.ends_at,
      missed_run_policy = excluded.missed_run_policy,
      metric_key = excluded.metric_key,
      comparison = excluded.comparison,
      threshold_value = excluded.threshold_value,
      lookback_days = excluded.lookback_days,
      minimum_sample = excluded.minimum_sample,
      updated_at = now()
    returning id
  `;
  return row!.id as string;
}

export async function getTriggerByKey(key: string): Promise<AutomationTrigger | null> {
  const [row] = await sql`select * from automation_triggers where key = ${key}`;
  return row ? toTrigger(row) : null;
}

export async function listTriggers(filters?: {
  kind?: string;
  projectId?: string | null;
}): Promise<AutomationTrigger[]> {
  const rows = await sql`
    select * from automation_triggers
    where (${filters?.kind ?? null}::text is null or kind = ${filters?.kind ?? null})
      and (${filters?.projectId ?? null}::uuid is null
           or project_id = ${filters?.projectId ?? null})
    order by kind, key
  `;
  return rows.map(toTrigger);
}

/** Schedule and threshold triggers whose time has come. */
export async function dueTriggers(now: Date): Promise<AutomationTrigger[]> {
  const rows = await sql`
    select * from automation_triggers
    where enabled
      and kind in ('schedule', 'threshold')
      and (starts_at is null or starts_at <= ${now})
      and (ends_at is null or ends_at >= ${now})
      and (next_run_at is null or next_run_at <= ${now})
    order by next_run_at nulls first
    limit 200
  `;
  return rows.map(toTrigger);
}

export async function setNextRun(
  tx: Tx,
  args: { triggerId: string; nextRunAt: Date | null; lastFireKey?: string | null; fired?: boolean }
): Promise<void> {
  await tx`
    update automation_triggers set
      next_run_at = ${args.nextRunAt},
      last_fire_key = ${args.lastFireKey ?? sql`last_fire_key`},
      last_fired_at = ${args.fired ? sql`now()` : sql`last_fired_at`},
      updated_at = now()
    where id = ${args.triggerId}
  `;
}

export async function setBreached(
  tx: Tx,
  triggerId: string,
  breached: boolean
): Promise<void> {
  await tx`
    update automation_triggers set last_breached = ${breached}, updated_at = now()
    where id = ${triggerId}
  `;
}

export async function setEnabled(
  tx: Tx,
  triggerId: string,
  enabled: boolean
): Promise<void> {
  await tx`
    update automation_triggers set enabled = ${enabled}, updated_at = now()
    where id = ${triggerId}
  `;
}

// ------------------------------------------------------------------ fires

function toFire(row: Record<string, unknown>): TriggerFire {
  return {
    id: row.id as string,
    triggerId: row.triggerId as string,
    fireKey: row.fireKey as string,
    firedAt: row.firedAt as Date,
    workflowRunId: (row.workflowRunId as string | null) ?? null,
    eventId: (row.eventId as string | null) ?? null,
    outcome: row.outcome as FireOutcome,
    detail: (row.detail as Record<string, unknown>) ?? {},
  };
}

/**
 * Record a fire, or return null when this window already fired. The unique
 * (trigger_id, fire_key) index is the reason a dispatcher can run every minute
 * without producing duplicate work.
 */
export async function claimFire(
  tx: Tx,
  args: {
    triggerId: string;
    fireKey: string;
    outcome: FireOutcome;
    detail?: Record<string, unknown>;
  }
): Promise<TriggerFire | null> {
  const [row] = await tx`
    insert into trigger_fires (trigger_id, fire_key, outcome, detail)
    values (${args.triggerId}, ${args.fireKey}, ${args.outcome},
      ${tx.json((args.detail ?? {}) as never)})
    on conflict (trigger_id, fire_key) do nothing
    returning *
  `;
  return row ? toFire(row) : null;
}

export async function attachFireResult(
  tx: Tx,
  args: {
    fireId: string;
    workflowRunId?: string | null;
    eventId?: string | null;
    outcome: FireOutcome;
    detail?: Record<string, unknown>;
  }
): Promise<void> {
  await tx`
    update trigger_fires set
      workflow_run_id = ${args.workflowRunId ?? null},
      event_id = ${args.eventId ?? null},
      outcome = ${args.outcome},
      detail = ${tx.json((args.detail ?? {}) as never)}
    where id = ${args.fireId}
  `;
}

export async function recentFires(triggerId: string, limit = 20): Promise<TriggerFire[]> {
  const rows = await sql`
    select * from trigger_fires where trigger_id = ${triggerId}
    order by fired_at desc limit ${limit}
  `;
  return rows.map(toFire);
}

export interface TriggerStats {
  triggerId: string;
  fires: number;
  fired: number;
  failed: number;
  lastFiredAt: Date | null;
}

export async function triggerStats(): Promise<Map<string, TriggerStats>> {
  const rows = await sql`
    select trigger_id,
      count(*)::int as fires,
      count(*) filter (where outcome = 'fired')::int as fired,
      count(*) filter (where outcome = 'failed')::int as failed,
      max(fired_at) as last_fired_at
    from trigger_fires group by trigger_id
  `;
  const map = new Map<string, TriggerStats>();
  for (const row of rows) {
    map.set(row.triggerId as string, {
      triggerId: row.triggerId as string,
      fires: Number(row.fires),
      fired: Number(row.fired),
      failed: Number(row.failed),
      lastFiredAt: (row.lastFiredAt as Date | null) ?? null,
    });
  }
  return map;
}

// ------------------------------------------------------------- webhooks

function toEndpoint(row: Record<string, unknown>): WebhookEndpoint {
  return {
    id: row.id as string,
    slug: row.slug as string,
    provider: row.provider as string,
    projectId: (row.projectId as string | null) ?? null,
    triggerId: (row.triggerId as string | null) ?? null,
    signatureScheme: row.signatureScheme as WebhookEndpoint["signatureScheme"],
    eventType: row.eventType as string,
    enabled: Boolean(row.enabled),
    rateLimitPerMinute: Number(row.rateLimitPerMinute ?? 60),
    revokedAt: (row.revokedAt as Date | null) ?? null,
  };
}

export async function endpointBySlug(slug: string): Promise<WebhookEndpoint | null> {
  const [row] = await sql`
    select id, slug, provider, project_id, trigger_id, signature_scheme,
           event_type, enabled, rate_limit_per_minute, revoked_at
    from webhook_endpoints where slug = ${slug}
  `;
  return row ? toEndpoint(row) : null;
}

export async function listWebhookEndpoints(): Promise<WebhookEndpoint[]> {
  const rows = await sql`
    select id, slug, provider, project_id, trigger_id, signature_scheme,
           event_type, enabled, rate_limit_per_minute, revoked_at
    from webhook_endpoints order by slug
  `;
  return rows.map(toEndpoint);
}

/**
 * The signing secret's ciphertext. Deliberately separate from `endpointBySlug`
 * so no page or action that lists endpoints can accidentally select it.
 */
export async function endpointSecretMaterial(
  endpointId: string
): Promise<{ ciphertext: Buffer; iv: Buffer; authTag: Buffer } | null> {
  const [row] = await sql`
    select secret_ciphertext, secret_iv, secret_auth_tag
    from webhook_endpoints where id = ${endpointId}
  `;
  if (!row?.secretCiphertext) return null;
  return {
    ciphertext: row.secretCiphertext as Buffer,
    iv: row.secretIv as Buffer,
    authTag: row.secretAuthTag as Buffer,
  };
}

/**
 * Record a receipt. Returns null when this provider event was already seen —
 * that is the replay guard, and the caller must treat null as "do nothing".
 */
export async function recordReceipt(
  tx: Tx,
  args: {
    endpointId: string;
    providerEventId: string;
    signatureValid: boolean;
    status: WebhookReceiptStatus;
    eventId?: string | null;
    error?: string | null;
  }
): Promise<string | null> {
  const [row] = await tx`
    insert into webhook_receipts (
      endpoint_id, provider_event_id, signature_valid, status, event_id, error
    ) values (
      ${args.endpointId}, ${args.providerEventId}, ${args.signatureValid},
      ${args.status}, ${args.eventId ?? null}, ${args.error ?? null}
    )
    on conflict (endpoint_id, provider_event_id) do nothing
    returning id
  `;
  return (row?.id as string) ?? null;
}

export async function attachReceiptEvent(
  tx: Tx,
  receiptId: string,
  eventId: string
): Promise<void> {
  await tx`update webhook_receipts set event_id = ${eventId} where id = ${receiptId}`;
}

/** Requests to this endpoint in the trailing minute, for rate limiting. */
export async function receiptsInLastMinute(endpointId: string): Promise<number> {
  const [row] = await sql`
    select count(*)::int as n from webhook_receipts
    where endpoint_id = ${endpointId} and received_at > now() - interval '1 minute'
  `;
  return Number(row?.n ?? 0);
}

export async function recentReceipts(limit = 50): Promise<
  {
    id: string;
    slug: string;
    provider: string;
    providerEventId: string;
    status: WebhookReceiptStatus;
    signatureValid: boolean;
    receivedAt: Date;
    error: string | null;
  }[]
> {
  const rows = await sql`
    select r.id, e.slug, e.provider, r.provider_event_id, r.status,
           r.signature_valid, r.received_at, r.error
    from webhook_receipts r
    join webhook_endpoints e on e.id = r.endpoint_id
    order by r.received_at desc limit ${limit}
  `;
  return rows.map((r) => ({
    id: r.id as string,
    slug: r.slug as string,
    provider: r.provider as string,
    providerEventId: r.providerEventId as string,
    status: r.status as WebhookReceiptStatus,
    signatureValid: Boolean(r.signatureValid),
    receivedAt: r.receivedAt as Date,
    error: (r.error as string | null) ?? null,
  }));
}
