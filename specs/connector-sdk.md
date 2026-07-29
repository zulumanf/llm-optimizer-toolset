# Spec — Connector SDK

> Status: implemented (adapter status labelled honestly per connector)
> Parent: `specs/native-automation-and-connector-layer.md`

## Goal

One provider-neutral contract for every external system, so that:

- a workflow node names a **capability** (`crm.create_contact`), never a
  vendor;
- provider quirks live in exactly one file per provider;
- swapping HubSpot for Follow Up Boss is a connection change, not a code
  change;
- no node handler, agent, or React component can ever see a credential.

## Existing capabilities

There is **no** integration layer in this repository today. The only external
calls are LLM provider calls, and those already follow the pattern this spec
generalises: `lib/ai/registry.ts` maps a provider name to an adapter, adapters
live in `lib/ai/{openai,anthropic,google,perplexity}.ts`, and a `mock.ts`
adapter serves tests. The connector SDK is the same shape applied to business
systems — deliberately, so there is one integration idiom in the codebase.

Reused: `lib/errors.ts` classification, `lib/ai/retry.ts` backoff semantics,
`db/audit.ts`, the exception queue, and the `forbid_mutation()` trigger.

## The contract

```ts
interface Connector<TConfig = unknown, TCapabilities extends string = ConnectorCapability> {
  id: string;                 // 'hubspot'
  provider: string;           // 'HubSpot'
  version: string;            // '1.0.0' — bumped when behaviour changes
  category: ConnectorCategory;
  status: ConnectorStatus;    // see "Honest status" below
  capabilities: TCapabilities[];
  configSchema: z.ZodType<TConfig>;

  validateConfiguration(config: unknown): Promise<ConfigurationValidationResult>;
  testConnection(ctx: ConnectorContext): Promise<ConnectionHealthResult>;
  execute<TInput, TOutput>(
    capability: TCapabilities,
    input: TInput,
    ctx: ConnectorExecutionContext,
  ): Promise<ConnectorExecutionResult<TOutput>>;
  refreshAuthorization?(ctx: ConnectorContext): Promise<AuthorizationRefreshResult>;
  revoke?(ctx: ConnectorContext): Promise<void>;
}
```

`ConnectorExecutionContext` carries: `connectionId`, `projectId`, `mode`
(`live` | `fixture`), a `secret` accessor scoped to this call, an `http` client
with timeout + retry + rate-limit handling, a `fixtures` reader, and the
`workflowRunId` / `nodeRunId` for audit. It does **not** carry `sql`.

`ConnectorExecutionResult` is always
`{ ok, data?, error?, statusCode?, retryable, rateLimited, latencyMs, requestId?, redacted: true }`.
A connector never throws for a provider error — it classifies. Throwing is
reserved for programming errors.

## Capability catalogue

Capabilities are the vocabulary workflows speak. Adding one is a deliberate act
(a constant + a type + at least one adapter).

```
analytics.fetch_sessions | fetch_events | fetch_landing_pages | fetch_referrals
search_console.fetch_queries | fetch_pages
crm.fetch_contacts | create_contact | update_contact | fetch_opportunities
  | update_opportunity | fetch_stage_history
email.read_thread | create_draft | send_approved_message
calendar.fetch_events | create_event | update_event
cms.create_draft | update_draft | publish_approved_asset | fetch_public_page
billing.create_invoice | fetch_invoice | send_reminder | fetch_payment_status
notification.send_internal | send_client
file.store | retrieve
```

Three capabilities are marked **consequential** and can never execute in test
mode or without a satisfied approval: `email.send_approved_message`,
`cms.publish_approved_asset`, `billing.create_invoice`. Two more are
conditionally consequential (`crm.create_contact`, `crm.update_contact`,
`crm.update_opportunity`) — blocked in test mode unless the run explicitly
opts in.

## Connection & credential model

`connector_connections`

```
id · project_id · provider · connection_name · external_account_id
· status ('pending'|'active'|'degraded'|'authorization_expired'|'revoked')
· granted_scopes text[] · config jsonb
· last_test_at · last_test_ok · last_sync_at · last_error · expires_at
· created_by · revoked_at · revoked_by
unique (project_id, provider, external_account_id) where revoked_at is null
```

`connector_credentials`

```
id · connection_id · kind ('oauth2'|'api_key'|'basic'|'hmac_secret')
· ciphertext bytea · iv bytea · auth_tag bytea · key_version smallint
· refresh_ciphertext bytea · refresh_iv · refresh_auth_tag
· expires_at · rotated_at · created_at
```

Encryption: AES-256-GCM, key from `AUTOMATION_CREDENTIAL_KEY` (base64, 32
bytes), additional-authenticated-data = `connection_id`, so a ciphertext moved
to another connection fails to decrypt. `key_version` supports rotation without
re-encrypting eagerly.

Access rules, enforced structurally:

- `db/connectors.ts` has **no** exported function returning ciphertext or
  plaintext. The only decryptor is `lib/connectors/credentials.ts`, which is
  imported by `lib/connectors/execute.ts` and by nothing else.
- The `secret` accessor handed to an adapter is a closure over a single call's
  decrypted value; it is not stored, not returned, and not serialisable.
- `redactSecrets()` scrubs token-shaped substrings from every error, log and
  stored `connector_health_checks` / `connector_sync_runs` row.
- No server component or server action ever selects credential columns.

## Data-mapping layer

`field_mapping_definitions` (source system, destination model, version,
client override, status) + `field_mapping_versions` (immutable field list).

A field mapping entry:

```
sourceField · destinationField · dataType · required · defaultValue
· transform ('none'|'trim'|'lowercase'|'uppercase'|'normalize_email'
            |'normalize_phone'|'normalize_url'|'parse_number'
            |'parse_currency'|'parse_date'|'boolean')
· validation ('none'|'email'|'phone'|'url'|'non_negative'|'iso_date')
```

`applyMapping(version, sourceRecord)` is a pure function returning
`{ ok, record, errors[] }`. Transforms are a closed enum — there is no custom
code path, which is exactly the "no arbitrary executable code in nodes" rule
applied to data.

An LLM may propose a mapping at onboarding (`suggested_by_agent`), but
`status` stays `proposed` until a human sets `approved_by`. `applyMapping`
refuses a non-approved version.

## Honest status labelling

The request is explicit: *do not pretend an integration works*. Every adapter
declares one of:

| Status | Meaning |
|---|---|
| `verified` | Executed end to end in this repository's tests against a real or fully-simulated endpoint. `fixture`, `csv`, `manual`, `internal_notification` only. |
| `implemented_unverified` | Written against the provider's documented HTTP contract; request/response shapes unit-tested against captured fixtures; **never executed against the live provider** because no credentials exist here. |
| `contract_only` | Interface, config validation and fixture mode exist; no live request path. |

The connector registry, the `/automation/connectors` page and
`docs/architecture/build-vs-borrow-boundaries.md` all show the status. Nothing
is labelled production-ready that has not been run.

## Adapters shipped

| Adapter | Category | Capabilities | Status |
|---|---|---|---|
| `fixture` | testing | all | `verified` |
| `csv` | ingestion | crm fetches, analytics fetches | `verified` |
| `manual` | ingestion | any (records an operator-entered payload) | `verified` |
| `internal_notification` | notification | `notification.send_internal` | `verified` (writes to `notifications`) |
| `ga4` | analytics | sessions, events, landing pages, referrals | `implemented_unverified` |
| `search_console` | analytics | queries, pages | `implemented_unverified` |
| `hubspot` | crm | contacts, opportunities, stage history | `implemented_unverified` |
| `follow_up_boss` | crm | contacts, opportunities | `implemented_unverified` |
| `salesforce` | crm | contacts, opportunities | `contract_only` |
| `gmail` | email | read thread, create draft, send approved | `implemented_unverified` |
| `google_calendar` | calendar | fetch/create/update event | `implemented_unverified` |
| `stripe` | billing | invoice create/fetch/reminder/payment status | `implemented_unverified` |
| `wordpress` | cms | draft/update/publish/fetch page | `implemented_unverified` |
| `webflow` | cms | draft/update/publish | `contract_only` |
| `slack` | notification | send internal | `implemented_unverified` |
| `local_file_store` | storage | store/retrieve | `verified` |

## Execution path

`executeCapability({ projectId, capability, input, mode, workflowRunId, nodeRunId })`:

1. Resolve the connection for `(projectId, capability)`. **`assertProjectScope`
   runs here** — a connection whose `project_id` differs from the run's is a
   `tenant_scope_violation` exception and a hard failure.
2. Refuse if `status` is `revoked` or `authorization_expired` (raising
   `connector_authorization_failed`).
3. If `mode === 'test'`, force the adapter's fixture path for read
   capabilities and **refuse** consequential ones.
4. Decrypt the secret into a call-scoped closure.
5. Call `adapter.execute` with timeout, bounded retry (exponential, respecting
   `Retry-After`), and rate-limit accounting.
6. Record `connector_sync_runs` (reads) or an audit row (writes), both
   redacted.
7. On failure, classify → `connector_request_failed` /
   `connector_rate_limited` / `connector_authorization_failed` exception;
   attempt `refreshAuthorization` once for an auth failure before giving up.

## Health

`checkConnection()` performs an authorisation probe and a minimal read, stores
a `connector_health_checks` row, updates `last_test_*`, and transitions status.
`integration_health_v1` runs it on a schedule and raises exceptions with client
impact. Expiry monitoring flags connections within 14 days of `expires_at`.

## Testing

Per adapter, against captured fixtures (no network): configuration validation
(valid + invalid), authorisation failure, successful request shape, rate
limiting with `Retry-After`, timeout, malformed provider response, mapping
failure, retry, revocation, tenant isolation.

Plus: encryption round-trip; decryption with wrong AAD fails; redaction over
nested structures; capability→adapter resolution; test-mode refusal of
consequential capabilities; credential columns absent from every selectable
accessor.

## Acceptance criteria

- [x] Workflows invoke capabilities, never providers.
- [x] No vendor SDK is imported outside `lib/connectors/adapters/`.
- [x] Credentials are encrypted at rest with per-connection AAD.
- [x] No accessor outside `lib/connectors/credentials.ts` can read a secret.
- [x] Secrets are redacted from errors, logs and stored results.
- [x] Cross-tenant connection access is refused and raises an exception.
- [x] Test mode cannot execute a consequential capability.
- [x] Every adapter declares an honest status.
- [x] Mappings are deterministic, versioned, approved, and unit-tested.

## Known limitations

- **No live provider call has been made from this repository.** See status
  table. This is a labelling problem solved by labelling, not by pretending.
- OAuth redirect flow is not implemented; tokens are pasted. Refresh, rotation
  and revocation are implemented and tested against fixtures.
- Rate limiting is per-process, not distributed. With one worker that is
  correct; with several it is conservative-per-worker.
- `salesforce` and `webflow` are `contract_only` — their config validation and
  fixture mode work; there is no live request path.
