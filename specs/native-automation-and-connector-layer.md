# Spec — Native Automation & Connector Layer

> Status: implemented (see "Known limitations" for what is deliberately not)
> Depends on: specs/018 (graph execution & control plane), specs/019 (control
> tower), specs/011 (outreach), specs/012 (vertical packs), docs/15, docs/17
> Companion specs: `domain-event-and-trigger-system.md`, `connector-sdk.md`,
> `automation-workflow-library.md`
> Architecture: `docs/architecture/native-automation-runtime.md`,
> `docs/architecture/build-vs-borrow-boundaries.md`
> Operations: `docs/operations/automation-safety-and-autonomy.md`

## Goal

Spec 018 gave this platform a workflow **engine**: a versioned directed graph,
executed by a tick, with fan-out, fan-in, approvals, autonomy, cost caps and an
exception queue. What it did not give it was a way for a graph to **start
without a human**, or to **touch the outside world**.

Every workflow run today begins with someone pressing a button, and every node
that needs an external system either does not exist or reaches for a vendor SDK
directly. That is the gap this spec closes:

- **In**: schedules, webhooks, domain events, thresholds, manual runs.
- **Out**: analytics, search console, CRM, email, calendar, billing, CMS,
  notifications, file storage — through one provider-neutral connector
  contract, never a vendor SDK in a feature module.
- **Between**: a reusable node library so a new business process is a *graph
  composed of existing nodes*, not a new service.

The product boundary is deliberate and stated in
`docs/architecture/build-vs-borrow-boundaries.md`: this is **not** a generic
n8n. It is an automation layer that understands clients, agents, teams,
brokerages, markets, claims, evidence, transactions, and outcomes — and refuses
to do things that would break the platform's role as system of record.

## Existing repository capabilities (2026-07-29 audit)

Reused as-is. Nothing below was rebuilt.

| Capability | Where | How this spec uses it |
|---|---|---|
| Versioned graph definitions, immutable versions | `db/migrations/017`, `db/workflow.ts` | Every automation workflow is a `workflow_definitions` row. No parallel table. |
| Tick engine: ready-set, fan-out/in, retries, timeouts, cost caps | `lib/workflow/engine.ts` | `AutomationRuntime` is a **thin adapter** over it. No second engine. |
| Pure graph algebra + validation | `lib/workflow/graph.ts` | Trigger-bearing graphs validate through the same function. |
| Durable Postgres queue, leases, backoff, stale reclaim | `db/jobs.ts`, `workers/index.ts` | Trigger dispatch, event delivery and connector sync are queue jobs. |
| Durable approval waits + immutable decisions | `workflow_approvals`, `lib/workflow/engine.ts` | Human nodes are `approval_gate` nodes. Unchanged. |
| Autonomy resolution (tenant/workflow/node/action/risk) | `lib/workflow/autonomy.ts`, `autonomy_policies` | Extended with connector- and action-type scoping; the resolver is the same. |
| Exception queue + deterministic priority | `lib/workflow/exceptions.ts` | Extended with 12 new kinds + SLAs. Same table, same formula. |
| Structured agent runner (pinned model, Zod, cost, injectable caller) | `lib/ai/agent.ts` | Every agent node calls it. Agents never get credentials — see below. |
| Agent registry with honest `implemented` / `declared` status | `lib/agents/registry.ts` | New automation agents register the same way. |
| Notifications delivery primitive | `lib/notifications/service.ts` | `notification.send_internal` maps onto it. |
| Evidence packets, claims, immutable raw responses | `lib/knowledge/packet.ts`, `evidence_artifacts` | Outreach and content claims resolve against these. |
| Audit log | `db/audit.ts` | Every connector call, credential touch and trigger fire is audited. |
| Control tower / cross-client attention feed | `db/control-tower.ts`, `lib/control-tower/` | The daily operator brief aggregates from it. |

## Gaps this spec closes

1. **No way to start work.** No scheduler beyond three hand-rolled cron routes
   (`app/api/cron/*`), no webhook intake, no event bus, no threshold watcher.
2. **No domain events.** State changes are invisible to anything that did not
   call the function that made them. There is no `claim.expired`, no
   `visibility.materially_declined`, nothing to subscribe to.
3. **No connector abstraction.** Zero external write integrations exist. A
   feature that needed HubSpot today would import a HubSpot SDK.
4. **No credential store.** No encrypted tokens, no refresh, no revocation, no
   expiry monitoring.
5. **No field mapping.** No canonical ↔ external field model, so every
   integration would invent its own translation.
6. **No test mode.** A workflow either runs for real or does not run. There is
   no way to exercise a graph without risking a live send.
7. **No suppression list.** Outreach (spec 011) has no global do-not-contact.
8. **Thin node library.** Three templates, each with bespoke handlers. Nothing
   reusable across processes.

## Proposed architecture

```
   schedules   webhooks   domain events   thresholds   manual
       │           │            │             │          │
       └───────────┴────────────┴─────────────┴──────────┘
                            │  lib/triggers  (evaluate → fire, idempotent)
                            ▼
                     domain event bus  (lib/events)
                   append-only  ·  versioned  ·  tenant-scoped
                            │  event_subscriptions
                            ▼
            ┌───────────────────────────────────────────┐
            │  AutomationRuntime  (lib/automation)      │  ← thin adapter
            │  registerWorkflow / start / signal /      │
            │  retryNode / cancel / getRun / exceptions │
            └───────────────┬───────────────────────────┘
                            │  delegates to
            ┌───────────────▼───────────────────────────┐
            │  spec 018 engine (lib/workflow/engine.ts) │  ← unchanged core
            └───────────────┬───────────────────────────┘
                            │  node handlers
   ┌────────────────────────┼────────────────────────────────────┐
   │ control · deterministic · agent · verification · human       │
   │ integration ────────────┐                                    │
   └─────────────────────────┼────────────────────────────────────┘
                             ▼
                  Connector SDK (lib/connectors)
       capability names in ·  provider adapters out ·  credentials sealed
                             ▼
        GA4 · GSC · HubSpot · FUB · Gmail · Calendar · Stripe ·
        WordPress · Webflow · Slack · CSV · manual · fixture
```

Two rules make the picture safe rather than merely tidy:

- **A node handler never receives a credential.** It receives a
  *capability name* and an *input*. `lib/connectors/execute.ts` resolves the
  connection, decrypts the token in its own scope, calls the adapter, and
  returns a redacted result. There is no code path from `NodeContext` to a
  secret — the same structural argument spec 018 makes for writes.
- **The platform stays the system of record.** Connectors are I/O, not truth.
  A CRM row is *ingested into* `automation` tables and reconciled; it never
  becomes the authority for a claim, an approval, an attribution or an outcome.

## Data model

New tables in `db/migrations/020_automation_layer.sql`. Existing
graph-control-plane tables are **reused, not duplicated** (per the request's own
instruction): `workflow_definitions`, `workflow_versions`, `workflow_nodes`,
`workflow_edges`, `workflow_runs`, `node_runs`, `workflow_approvals`,
`workflow_exceptions`, `autonomy_policies`, `agent_definitions` all serve the
automation layer unchanged.

| Table | Purpose | Key invariants |
|---|---|---|
| `domain_events` | The event log | Append-only (`forbid_mutation`), versioned, tenant-scoped, correlation/causation IDs |
| `event_subscriptions` | Which workflow a type starts | Unique `(event_type, workflow_key)`; carries filter + autonomy note |
| `event_delivery_attempts` | Idempotent consumption, DLQ | Unique `(event_id, subscription_id)`; `attempts`, `dead_lettered_at` |
| `automation_triggers` | Schedule / webhook / event / threshold / manual | `next_run_at`, timezone, enabled, tenant scope |
| `trigger_fires` | Idempotency + missed-run handling | Unique `(trigger_id, fire_key)` — the same window never fires twice |
| `webhook_receipts` | Replay protection | Unique `(endpoint_id, provider_event_id)`; stores signature verdict |
| `connector_connections` | An authorised account | Unique `(project_id, provider, external_account_id)`; status, scopes, last test/sync |
| `connector_credentials` | Encrypted secrets | AES-256-GCM at rest; `forbid_mutation` on delete; never selected into app payloads |
| `connector_health_checks` | Authorisation + read probes | Append-only |
| `connector_sync_runs` | Ingestion bookkeeping | Freshness + row counts per capability |
| `field_mapping_definitions` / `field_mapping_versions` | Canonical ↔ external | Versions immutable; client override allowed; `approved_by` required to activate |
| `suppression_entries` | Global do-not-contact | Unique on `(scope, normalized_value)`; append-only reasons |
| `outreach_sequences` / `outreach_messages` | Sequenced outreach with stop rules | Message unique on `(sequence_id, step)`; `sent_at` immutable |
| `meeting_briefs` / `meeting_decisions` | Meeting prep & follow-up | Decisions carry owner, due date, evidence source |
| `support_requests` | Client support intake | Classification + autonomy verdict recorded |
| `billing_events` | Invoice lifecycle | Amounts are `numeric`, computed deterministically — never by an LLM |
| `workflow_fixtures` | Test-mode inputs | Keyed by `(workflow_key, name)` |

`workflow_runs` gains **one** additive column: `mode text not null default
'live' check (mode in ('live','test'))`. This is the single schema change to an
existing table; it is additive, defaulted, and reversible.

## Runtime model

`AutomationRuntime` (`lib/automation/runtime.ts`) is the interface the request
asks for, implemented as an adapter over the spec-018 engine:

```ts
interface AutomationRuntime {
  registerWorkflow(definition: AutomationWorkflowDefinition): Promise<void>;
  publishWorkflowVersion(workflowId: string, version: number): Promise<void>;
  startWorkflow(input: StartAutomationWorkflowInput): Promise<AutomationWorkflowRun>;
  signalWorkflow(workflowRunId: string, signal: AutomationWorkflowSignal): Promise<void>;
  retryNode(nodeRunId: string): Promise<void>;
  cancelWorkflow(workflowRunId: string, reason: string): Promise<void>;
  getRun(workflowRunId: string): Promise<AutomationWorkflowRun>;
  listExceptions(filters: AutomationExceptionFilters): Promise<AutomationException[]>;
}
```

`AutomationWorkflowDefinition` **extends** the spec-018 `WorkflowDefinition`
with the operational metadata Part 5 requires (domain, client scope, triggers,
owner, risk classification, max cost, max duration, concurrency, retry budget,
required approvals/permissions/connectors, evaluation suite, publication and
deprecation dates). Those fields are carried in the definition's `spec` JSON —
they change *policy*, not *graph shape*, so they must not force a new node
schema.

Execution is unchanged: `advance_workflow` on the existing queue. Long-running
workflows survive restarts because every decision is recomputed from Postgres.

## Node types

Ten categories, all registered into the existing `lib/workflow/handlers.ts`
registry. Full catalogue in `automation-workflow-library.md`. Summary:

| Category | Examples | Effectful? |
|---|---|---|
| Trigger | `schedule_trigger`, `webhook_trigger`, `domain_event_trigger`, `threshold_trigger`, `manual_trigger` | no |
| Control | `condition`, `switch`, `fan_out`, `fan_in`, `wait`, `retry`, `rate_limit`, `cost_limit`, `approval_gate`, `evidence_gate`, `confidence_gate`, `autonomy_gate`, `scope_gate`, `safe_stop`, terminals | no |
| Deterministic | records, normalisation, metrics, priority, health, attribution, mapping, hashing, permission & freshness checks | writes internal state only |
| Agent | classification, extraction, verification, diagnosis, drafting, reporting | no (drafts only) |
| Verification | independent re-checks with fresh context | no |
| Integration | every connector capability | **yes** |
| Human | approvals and verifications | gate |
| Data | export, dedupe, transform | no |
| Notification | internal + client | **yes** |
| Terminal | success / failure / safe stop | no |

`isEffectful()` in `lib/workflow/autonomy.ts` already encodes the distinction
that matters: gates and verifications are *guards*, not consequential acts, so
autonomy approval attaches to the acting node, not to its guard.

## Connector model

See `connector-sdk.md`. In brief: the workflow layer names a **capability**
(`crm.create_contact`), never a provider. A `Connector` implements
`validateConfiguration`, `testConnection`, `execute`, and optionally
`refreshAuthorization` / `revoke`. Adapters declare which capabilities they
support; a workflow that requires a capability no connected provider supports
fails **validation**, not runtime.

Every adapter supports a `fixture` execution mode, which is what test mode and
the E2E demos use.

## Credential management

- AES-256-GCM envelope encryption via `AUTOMATION_CREDENTIAL_KEY` (32-byte,
  base64). Absent key ⇒ credential writes fail closed with a classified error;
  no silent plaintext fallback.
- Tokens live only in `connector_credentials`. `db/connectors.ts` exposes
  **no** accessor that returns ciphertext or plaintext to a caller outside
  `lib/connectors/credentials.ts`.
- `redactSecrets()` runs over every connector error, log line and stored result.
- Rotation, revocation, expiry monitoring and health probes are first-class;
  `integration_health_v1` runs them on a schedule.

## Data-mapping strategy

Deterministic, versioned, stored, approved. An LLM may *suggest* a mapping
during onboarding; the suggestion is written to
`field_mapping_versions.suggested_by_agent` and cannot be used until a human
approves it. After onboarding no LLM participates in routine mapping — the
mapping is a pure function (`applyMapping`) over a stored definition, unit
tested against fixtures.

## Workflow templates

Seventeen, in `automation-workflow-library.md`. Shipped in phases 4–7.

## Security

Full posture in `docs/operations/automation-safety-and-autonomy.md`. Load
bearing points:

- Every automation table carries `project_id`; every accessor filters on it.
  `assertProjectScope()` is called at the connector boundary so a node in
  client A's run cannot resolve client B's connection — enforced *and tested*.
- Webhooks: HMAC signature verification with constant-time comparison,
  timestamp window, replay rejection on `(endpoint, provider_event_id)`.
- External sends verify, in order: authorisation → suppression → approval →
  tenant match → message version → consent. A missing check fails closed.
- Agents receive redacted context. `allowedDataScopes` in the agent registry is
  the allowlist; credentials are never in scope.
- No cross-client agent context: an agent node's evidence packet is built from
  its run's `project_id` only.

## Failure handling

Twelve new exception kinds join the existing nineteen, each with an SLA:
`connector_authorization_failed`, `connector_request_failed`,
`webhook_signature_invalid`, `workflow_timeout`, `node_schema_invalid`,
`node_retry_exhausted`, `evidence_expired`, `duplicate_event`,
`tenant_scope_violation`, `mapping_failed`, `suppressed_recipient`,
`connector_rate_limited`. Nothing fails silently: every terminal failure, safe
stop, dead-lettered event and failed connector call raises a row.

## Observability

`lib/automation/metrics.ts` computes workflow, connector, agent and business
metrics from durable rows — no estimates. Labour-savings figures are **not**
reported: the request asks for them only when a real baseline exists, and none
does. The UI says so rather than showing a fabricated number.

## Testing

Unit (no DB): trigger schedule maths, threshold classification, event
versioning/idempotency, mapping transforms, suppression matching, redaction,
capability validation, autonomy for connectors, test-mode guards, priority.

Integration (test DB): webhook → event → workflow → agent → mock connector →
approval pause → signal → resume → external action → system-of-record update →
audit; duplicate event; dead-letter; connector auth failure → exception →
recovery without duplicate writes; cross-client isolation.

E2E demos: the four scenarios in Part 40, fixture-driven.

## Migration strategy

Purely additive and parallel:

1. `020_automation_layer.sql` creates new tables and adds one defaulted column.
   Nothing existing is dropped or rewritten. `down` reverses both.
2. The three spec-018 templates keep running untouched.
3. `app/api/cron/*` routes stay; they now *also* dispatch triggers, so the
   existing scheduling entry point is reused rather than replaced.
4. `lib/cycles/service.ts` is untouched (spec 018 already deferred its
   retirement).

## Acceptance criteria

- [x] Workflows start from schedule, webhook, domain event, threshold and
      manual triggers.
- [x] Every automation workflow executes through the spec-018 engine; no
      second execution model exists.
- [x] Independent nodes run concurrently up to the run's bound.
- [x] Runs survive process restart (state in Postgres; tick re-entrant).
- [x] Approval pauses and signal-resumes durably; decisions immutable.
- [x] External actions go through connector capabilities; no vendor SDK is
      imported outside `lib/connectors/adapters/`.
- [x] Credentials encrypted at rest, tenant-scoped, never in logs, prompts or
      browser payloads.
- [x] Test mode blocks live sends, publishes, invoices and CRM mutations.
- [x] Idempotency prevents duplicate events, fires, sends and node work.
- [x] Every failure creates a visible exception with severity, owner and SLA.
- [x] Suppression blocks prohibited outreach at the send boundary.
- [x] Agents cannot reach credentials or mutate protected state.
- [x] Low-confidence outputs route to human review.
- [x] Outreach claims link to evidence; unsupported claims block the send.
- [x] Attribution confidence is disclosed, never asserted as confirmed.
- [x] Cross-client access is prevented and tested.
- [x] `npm run typecheck`, `npm run lint`, `npm test` pass; migration applies
      and rolls back; `npm run build` passes.

## Known limitations

Stated so nothing here is over-claimed.

- **No provider credentials exist in this environment.** Every live adapter is
  implemented against the provider's documented HTTP contract but has **never
  been executed against the real API**. They are labelled
  `implemented_unverified` in the connector registry and in the UI. Only
  `fixture`, `csv` and `manual` connectors are `verified`.
- **OAuth authorisation-code flow is not wired.** The credential store,
  refresh, rotation and revocation paths exist and are tested; the browser
  redirect dance is not built. Connections are created by pasting a token.
- **No visual DAG editor.** Read-only graph visualisation, a structured
  definition inspector and a template configurator ship instead; the path to a
  canvas is documented in `automation-workflow-library.md`.
- **RLS is still absent**, for the same reason spec 018 recorded: real auth is
  blocked on a Supabase project. Tenant isolation is a service-layer invariant
  with security tests.
- **Agent nodes reuse the existing single-provider runner.** Multi-provider
  agent execution is out of scope.
- **Labour-savings metrics are not computed** — no baseline exists.
