# Spec — Domain Event & Trigger System

> Status: implemented
> Parent: `specs/native-automation-and-connector-layer.md`
> Depends on: specs/018 (engine, exceptions), `db/jobs.ts` (queue)

## Goal

Give the platform a way to **start work without a human** and a way for one
part of the system to know that another part changed something — without
either part importing the other.

Two primitives, in dependency order:

1. **Domain events** — the append-only, versioned, tenant-scoped record of
   "something meaningful happened".
2. **Triggers** — the five ways a workflow run comes into existence. Four of
   them ultimately publish or consume a domain event; the fifth (manual) is a
   person.

## Existing capabilities

| Capability | Where | Verdict |
|---|---|---|
| Durable queue with lease/backoff/reclaim | `db/jobs.ts` | Reused for dispatch and delivery. No new queue. |
| Cron entry points | `app/api/cron/weekly-cycle`, `weekly-baseline`, `notifications` | Reused: they now also call `dispatchDueTriggers()`. |
| Bearer-secret cron auth | `CRON_SECRET` in `lib/env.ts` | Reused for the trigger dispatch route. |
| Idempotent workflow start | `workflow_runs.idempotency_key` unique | This is what makes a re-fired trigger harmless. |
| Exception queue | `lib/workflow/exceptions.ts` | Dead letters and invalid signatures raise rows here. |
| Audit log | `db/audit.ts` | Every fire and every webhook receipt is audited. |

## Gaps

- No event log at all. `syncNotifications()` derives an attention feed by
  *polling* the world; nothing publishes.
- No scheduler. Three hand-written cron routes, each hard-coded to one job.
- No webhook intake, no signature verification, no replay protection.
- No threshold watcher. `visibility.materially_declined` exists as a concept in
  `lib/reports/executive.ts` but nothing turns it into an event.

## Data model

### `domain_events`

```
id uuid pk
type text not null                     -- 'claim.expired'
version integer not null default 1     -- payload schema version
occurred_at timestamptz not null default now()
project_id uuid references projects(id)      -- client scope (nullable = platform)
actor_user_id uuid                            -- who caused it, when a human did
correlation_id uuid not null                  -- the causal chain's root
causation_id uuid                             -- the event that caused this one
workflow_run_id uuid references workflow_runs(id)
node_run_id uuid references node_runs(id)
source text not null                          -- 'trigger' | 'workflow' | 'webhook' | 'service'
payload jsonb not null default '{}'
metadata jsonb not null default '{}'
dedupe_key text                               -- unique when present
```

`forbid_mutation()` trigger: **insert-only**. An event is evidence of what the
platform believed at a point in time; editing one would be editing history.

`dedupe_key` carries a partial unique index. A producer that can compute a
natural key (`claim.expired:<claimId>:<date>`) gets exactly-once publication for
free; one that cannot omits it.

### `event_subscriptions`

```
id · event_type · workflow_key · filter jsonb · enabled · project_id (null = all)
· idempotency_template text     -- e.g. 'lead_qual:{{event.id}}'
· autonomy_note text            -- why this is safe to start unattended
unique (event_type, workflow_key, coalesce(project_id, '0000…'))
```

`filter` is **data, not an expression** — the same decision spec 018 made for
edge conditions. Supported forms mirror `EdgeCondition`: `payload_equals`,
`payload_gte`, `payload_lt`, `payload_truthy`, `always`. There is no `eval`.

### `event_delivery_attempts`

```
id · event_id · subscription_id · status ('pending'|'delivered'|'failed'|'dead_lettered')
· attempts smallint · workflow_run_id · last_error · dead_lettered_at
unique (event_id, subscription_id)
```

The unique index **is** the idempotent-consumption guarantee: a redelivered
event cannot start a second run of the same subscription. Three failed attempts
dead-letter the row and raise a `failed_workflow` exception. Replay is an
explicit operator action that resets the row and re-enqueues.

### `automation_triggers`

```
id · key (unique) · kind ('schedule'|'webhook'|'domain_event'|'threshold'|'manual')
· workflow_key · project_id · enabled · config jsonb
· timezone text default 'UTC'
· cron text                    -- schedule only
· starts_at · ends_at
· missed_run_policy ('skip'|'run_once'|'run_all') default 'run_once'
· next_run_at · last_fired_at · last_fire_key
```

### `trigger_fires`

```
id · trigger_id · fire_key text · fired_at · workflow_run_id · outcome · detail jsonb
unique (trigger_id, fire_key)
```

`fire_key` is the *window identity*, not a timestamp: for a schedule it is the
ISO instant of the scheduled slot (`2026-08-03T09:00:00Z`), so a dispatcher
that runs twice, or two workers racing, produce one fire. Missed-run policy is
implemented entirely in terms of which `fire_key`s are generated when catching
up — `skip` emits only the newest, `run_once` emits the newest and marks the
rest skipped, `run_all` emits every missed slot.

### `webhook_endpoints` / `webhook_receipts`

```
webhook_endpoints:  id · slug (unique) · provider · project_id · trigger_id
                  · secret_ciphertext · signature_scheme · enabled
                  · rate_limit_per_minute · created_by · revoked_at

webhook_receipts:   id · endpoint_id · provider_event_id · signature_valid
                  · received_at · status · event_id · error
unique (endpoint_id, provider_event_id)
```

## Runtime model

### Publishing

```ts
await publishEvent(tx, {
  type: "claim.expired", version: 1, projectId, source: "service",
  payload: { claimId, expiredAt }, dedupeKey: `claim.expired:${claimId}`,
  correlationId, causationId,
});
```

Publication is **transactional with the state change that caused it**. That is
the whole reason the bus lives in Postgres: `publishEvent` takes the caller's
transaction, so an event cannot exist for a write that rolled back, and a write
cannot commit without its event. No outbox, no dual-write.

Publishing enqueues one `deliver_events` job. Delivery, in the worker:

1. Load undelivered `(event, subscription)` pairs.
2. Evaluate the subscription filter (pure, data-driven).
3. Check tenant scope: a subscription scoped to project X never sees project
   Y's events. A cross-scope match raises `tenant_scope_violation` and refuses.
4. Render the idempotency key from the template.
5. `startWorkflow` with that key — duplicate delivery collapses onto the run
   that already exists.
6. Record the attempt. Failure ⇒ retry with backoff; third failure ⇒
   dead-letter + exception.

### The event catalogue

Typed, versioned, exhaustive. `lib/events/catalog.ts` declares every type with
its payload Zod schema; `publishEvent` validates against it and refuses an
unknown type. The 32 types in the request are all declared, grouped:
`client.*`, `benchmark.*`, `visibility.*`, `claim.*`, `content.*`, `profile.*`,
`transaction.*`, `lead.*`, `opportunity.*`, `integration.*`, `approval.*`,
`invoice.*`.

An event's `version` is part of its identity. Changing a payload shape means
publishing `version: 2` and keeping the v1 schema readable — consumers declare
which versions they accept.

### Trigger kinds

**A. Schedule.** Cron expression + IANA timezone, evaluated by a dependency-free
parser (`lib/triggers/cron.ts`) that supports the five standard fields plus
step and range syntax. Timezone handling uses `Intl.DateTimeFormat` offsets, so
a 09:00 America/New_York schedule stays at 09:00 across a DST boundary. Missed
runs are governed by `missed_run_policy`; the dispatcher is safe to run at any
frequency because `fire_key` is the window, not the moment.

**B. Webhook.** `POST /api/webhooks/[slug]`. In order: rate limit → resolve
endpoint → verify signature (HMAC-SHA256, constant-time, timestamp window
±5 min) → replay check on `(endpoint, provider_event_id)` → schema validation →
publish domain event → 202. Every rejection is recorded in
`webhook_receipts` with the reason and raises
`webhook_signature_invalid` on a signature failure. A webhook **never** starts
a workflow directly — it publishes an event, and a subscription decides. That
keeps one path from the outside world into execution.

**C. Domain event.** An `event_subscriptions` row. Described above.

**D. Threshold.** Deterministic, no LLM. A threshold trigger declares a metric
key, a comparison, a value, a lookback window and a minimum sample. Evaluation
(`lib/triggers/threshold.ts`) computes the metric from durable rows, compares,
and publishes an event only on a **transition** (below→above), so a metric that
sits past its threshold does not fire every tick. Insufficient sample ⇒ no
fire and a recorded `insufficient_sample` outcome — never a guess.

**E. Manual.** A server action requiring a role, a client, a reason and an
explicit `mode` (`live` | `test`). Every manual start writes an audit row with
the reason. A manual start with no reason is rejected.

## Security

- Tenant scope is checked at subscription match, at trigger dispatch and at
  workflow start. Three independent checks, because a single one is a single
  point of failure.
- Webhook secrets are encrypted with the same envelope scheme as connector
  credentials and never returned by any accessor.
- The dispatch route requires `CRON_SECRET`; without it configured, the route
  refuses rather than running open.
- Events are redacted before they are logged; payloads are validated, so a
  provider cannot smuggle an unbounded blob into the event log.

## Failure handling

| Failure | Behaviour |
|---|---|
| Unknown event type | `publishEvent` throws `validation` — nothing is written |
| Payload fails schema | Same |
| Subscription filter throws | Attempt marked failed, retried, then dead-lettered |
| Workflow start fails | Attempt failed + retried with backoff |
| 3 failed attempts | Dead-letter + `failed_workflow` exception |
| Invalid signature | Receipt stored, `webhook_signature_invalid` exception, 401 |
| Replayed webhook | Receipt already exists ⇒ 200 with `duplicate: true`, no event |
| Threshold with too small a sample | No fire; outcome recorded |
| Trigger fires while its workflow key is unpublished | Fire recorded `failed`, exception raised |

## Observability

Per trigger: fires, success rate, last fire, next run, skipped-missed count.
Per event type: published, delivered, dead-lettered, mean delivery latency.
Surfaced at `/automation/events` and `/automation/triggers`.

## Testing

Unit: cron parsing and next-occurrence across DST; missed-run policies;
fire-key generation; filter evaluation for every form; event schema validation;
threshold transition detection and insufficient-sample refusal; HMAC
verification including constant-time behaviour and window rejection.

Integration: publish → deliver → workflow started; duplicate publication with
the same `dedupe_key` writes one row; redelivery starts no second run; delivery
failure retries then dead-letters and raises an exception; webhook happy path,
bad signature, replay; cross-tenant subscription refusal.

## Acceptance criteria

- [x] Events are append-only, typed, versioned, tenant-scoped, and carry
      correlation + causation IDs.
- [x] An unknown or schema-invalid event cannot be published.
- [x] A duplicate event with the same dedupe key is written once.
- [x] Redelivery cannot start a second workflow run.
- [x] Failed delivery retries, then dead-letters visibly.
- [x] Schedules honour timezone and DST, and never double-fire a window.
- [x] Missed runs follow the declared policy.
- [x] Webhooks verify signatures, reject replays, and never start a workflow
      directly.
- [x] Threshold triggers use deterministic logic and fire on transitions only.
- [x] Manual triggers require role, reason and explicit mode, and are audited.

## Known limitations

- The cron parser supports standard five-field expressions with `*`, `,`, `-`
  and `/`. It does **not** support `L`, `W`, `#`, or seconds. Unsupported
  syntax is rejected at trigger creation, not silently mis-scheduled.
- Delivery is at-least-once with idempotent consumption, not exactly-once.
  That is the honest guarantee a Postgres queue gives.
- Dispatch latency is bounded by how often the cron route runs (recommended:
  every minute). Sub-minute schedules are rejected.
