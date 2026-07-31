-- Spec: native automation & connector layer.
--
-- Design notes the column list does not carry:
--  * Nothing here duplicates the spec-018 graph control plane. Automation
--    workflows ARE workflow_definitions rows; automation runs ARE
--    workflow_runs rows. The only change to an existing table is one
--    additive, defaulted column (workflow_runs.mode).
--  * Four unique indexes carry every idempotency guarantee in the layer:
--      trigger_fires (trigger_id, fire_key)          — a window fires once
--      event_delivery_attempts (event_id, sub_id)    — a subscription consumes once
--      webhook_receipts (endpoint_id, provider_event_id) — replay protection
--      domain_events (dedupe_key)                    — exactly-once publication
--  * domain_events is insert-only. An event is what the platform believed at a
--    point in time; editing one edits history (PRINCIPLES #3).
--  * connector_credentials stores ciphertext only. AES-256-GCM with the
--    connection id as additional authenticated data, so a ciphertext moved to
--    another connection cannot be decrypted.

-- +migrate up

-- ------------------------------------------------------------ domain events

create table domain_events (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  version integer not null default 1,
  occurred_at timestamptz not null default now(),
  -- Tenant key. Null = platform-scoped event (no client involved).
  project_id uuid references projects(id),
  actor_user_id uuid,
  -- The causal chain: correlation is the root, causation is the direct parent.
  correlation_id uuid not null,
  causation_id uuid,
  workflow_run_id uuid references workflow_runs(id),
  node_run_id uuid references node_runs(id),
  source text not null default 'service'
    check (source in ('trigger', 'workflow', 'webhook', 'service', 'manual')),
  payload jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  -- Natural key for exactly-once publication; null when the producer has none.
  dedupe_key text,
  created_at timestamptz not null default now()
);
create unique index domain_events_dedupe on domain_events (dedupe_key)
  where dedupe_key is not null;
create index domain_events_type_idx on domain_events (type, occurred_at desc);
create index domain_events_project_idx on domain_events (project_id, occurred_at desc);
create index domain_events_correlation_idx on domain_events (correlation_id);
create trigger domain_events_immutable
  before update or delete on domain_events
  for each row execute function forbid_mutation();

create table event_subscriptions (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,
  workflow_key text not null,
  -- Null = every client. A non-null value scopes delivery to one client.
  project_id uuid references projects(id),
  -- Data, never an expression: {kind, path, value}. There is no eval.
  filter jsonb not null default '{"kind":"always"}'::jsonb,
  -- Template rendered into the started run's idempotency key.
  idempotency_template text not null default 'evt:{{event.id}}',
  -- Why starting this unattended is safe. Required prose, not decoration.
  autonomy_note text not null default '',
  accepted_versions integer[] not null default '{1}',
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid
);
create unique index event_subscriptions_unique
  on event_subscriptions (event_type, workflow_key, coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index event_subscriptions_type_idx on event_subscriptions (event_type) where enabled;

create table event_delivery_attempts (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references domain_events(id),
  subscription_id uuid not null references event_subscriptions(id),
  status text not null default 'pending'
    check (status in ('pending', 'delivered', 'skipped', 'failed', 'dead_lettered')),
  attempts smallint not null default 0,
  workflow_run_id uuid references workflow_runs(id),
  last_error text,
  next_attempt_at timestamptz,
  dead_lettered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- The idempotent-consumption guarantee: one attempt row per (event, subscription).
create unique index event_delivery_unique
  on event_delivery_attempts (event_id, subscription_id);
create index event_delivery_pending_idx
  on event_delivery_attempts (status, next_attempt_at)
  where status in ('pending', 'failed');

-- ---------------------------------------------------------------- triggers

create table automation_triggers (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  kind text not null check (kind in
    ('schedule', 'webhook', 'domain_event', 'threshold', 'manual')),
  workflow_key text not null,
  project_id uuid references projects(id),
  name text not null default '',
  description text not null default '',
  enabled boolean not null default true,
  config jsonb not null default '{}'::jsonb,
  -- Schedule fields
  cron text,
  timezone text not null default 'UTC',
  starts_at timestamptz,
  ends_at timestamptz,
  missed_run_policy text not null default 'run_once'
    check (missed_run_policy in ('skip', 'run_once', 'run_all')),
  next_run_at timestamptz,
  last_fired_at timestamptz,
  last_fire_key text,
  -- Threshold fields
  metric_key text,
  comparison text check (comparison in ('gt', 'gte', 'lt', 'lte')),
  threshold_value numeric,
  lookback_days integer,
  minimum_sample integer,
  -- Last evaluation, so a threshold fires on transition rather than every tick
  last_breached boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid
);
create index automation_triggers_due_idx
  on automation_triggers (next_run_at) where enabled and kind = 'schedule';
create index automation_triggers_project_idx on automation_triggers (project_id);

create table trigger_fires (
  id uuid primary key default gen_random_uuid(),
  trigger_id uuid not null references automation_triggers(id),
  -- The window's identity, not the moment of firing. Two workers racing on the
  -- same scheduled slot produce one row.
  fire_key text not null,
  fired_at timestamptz not null default now(),
  workflow_run_id uuid references workflow_runs(id),
  event_id uuid references domain_events(id),
  outcome text not null default 'fired'
    check (outcome in ('fired', 'skipped_missed', 'suppressed', 'insufficient_sample', 'failed')),
  detail jsonb not null default '{}'::jsonb
);
create unique index trigger_fires_window on trigger_fires (trigger_id, fire_key);
create index trigger_fires_recent_idx on trigger_fires (trigger_id, fired_at desc);

create table webhook_endpoints (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  provider text not null,
  project_id uuid references projects(id),
  trigger_id uuid references automation_triggers(id),
  -- The signing secret, encrypted with the same envelope scheme as credentials
  secret_ciphertext bytea,
  secret_iv bytea,
  secret_auth_tag bytea,
  signature_scheme text not null default 'hmac_sha256'
    check (signature_scheme in ('hmac_sha256', 'stripe', 'none')),
  event_type text not null,
  enabled boolean not null default true,
  rate_limit_per_minute integer not null default 60,
  created_at timestamptz not null default now(),
  created_by uuid,
  revoked_at timestamptz
);

create table webhook_receipts (
  id uuid primary key default gen_random_uuid(),
  endpoint_id uuid not null references webhook_endpoints(id),
  provider_event_id text not null,
  signature_valid boolean not null,
  status text not null
    check (status in ('accepted', 'duplicate', 'rejected_signature',
                      'rejected_schema', 'rejected_rate_limit', 'rejected_disabled')),
  event_id uuid references domain_events(id),
  error text,
  received_at timestamptz not null default now()
);
create unique index webhook_receipts_replay
  on webhook_receipts (endpoint_id, provider_event_id);
create index webhook_receipts_recent_idx on webhook_receipts (endpoint_id, received_at desc);

-- --------------------------------------------------------------- connectors

create table connector_connections (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id),
  provider text not null,
  connection_name text not null default '',
  external_account_id text not null default '',
  status text not null default 'pending'
    check (status in ('pending', 'active', 'degraded', 'authorization_expired', 'revoked')),
  granted_scopes text[] not null default '{}',
  config jsonb not null default '{}'::jsonb,
  last_test_at timestamptz,
  last_test_ok boolean,
  last_sync_at timestamptz,
  last_error text,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid,
  revoked_at timestamptz,
  revoked_by uuid
);
-- One live connection per (client, provider, account). Revoked rows stay for audit.
create unique index connector_connections_account
  on connector_connections (project_id, provider, external_account_id)
  where revoked_at is null;
create index connector_connections_project_idx on connector_connections (project_id, provider);

create table connector_credentials (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references connector_connections(id),
  kind text not null check (kind in ('oauth2', 'api_key', 'basic', 'hmac_secret')),
  -- Ciphertext only. Nothing in db/ returns these columns to a caller.
  ciphertext bytea not null,
  iv bytea not null,
  auth_tag bytea not null,
  refresh_ciphertext bytea,
  refresh_iv bytea,
  refresh_auth_tag bytea,
  key_version smallint not null default 1,
  expires_at timestamptz,
  rotated_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index connector_credentials_one_per_connection
  on connector_credentials (connection_id);

create table connector_health_checks (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references connector_connections(id),
  project_id uuid references projects(id),
  checked_at timestamptz not null default now(),
  authorization_ok boolean not null,
  read_ok boolean not null,
  latency_ms integer,
  -- Redacted before insert. Never contains a token.
  error_code text,
  error_message text,
  severity text not null default 'low'
    check (severity in ('low', 'medium', 'high', 'critical')),
  detail jsonb not null default '{}'::jsonb
);
create index connector_health_recent_idx
  on connector_health_checks (connection_id, checked_at desc);
create trigger connector_health_checks_immutable
  before update or delete on connector_health_checks
  for each row execute function forbid_mutation();

create table connector_sync_runs (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references connector_connections(id),
  project_id uuid references projects(id),
  capability text not null,
  workflow_run_id uuid references workflow_runs(id),
  node_run_id uuid references node_runs(id),
  mode text not null default 'live' check (mode in ('live', 'test')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  ok boolean,
  rows_read integer not null default 0,
  rows_written integer not null default 0,
  latency_ms integer,
  rate_limited boolean not null default false,
  error text,
  -- Window covered, so data freshness is a fact rather than an assumption
  period_start timestamptz,
  period_end timestamptz
);
create index connector_sync_recent_idx
  on connector_sync_runs (connection_id, started_at desc);
create index connector_sync_capability_idx
  on connector_sync_runs (project_id, capability, started_at desc);

-- ------------------------------------------------------------ field mapping

create table field_mapping_definitions (
  id uuid primary key default gen_random_uuid(),
  key text not null,
  source_system text not null,
  destination_model text not null,
  -- Null = platform default; non-null = this client's override
  project_id uuid references projects(id),
  description text not null default '',
  active_version integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index field_mapping_definitions_key
  on field_mapping_definitions (key, coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid));

create table field_mapping_versions (
  id uuid primary key default gen_random_uuid(),
  definition_id uuid not null references field_mapping_definitions(id),
  version integer not null,
  -- [{sourceField, destinationField, dataType, required, defaultValue,
  --   transform, validation}] — transform is a closed enum, never code.
  fields jsonb not null,
  status text not null default 'proposed'
    check (status in ('proposed', 'approved', 'deprecated')),
  -- An LLM may propose a mapping; only a human may approve one.
  suggested_by_agent text,
  approved_by uuid,
  approved_at timestamptz,
  test_result jsonb,
  created_at timestamptz not null default now(),
  created_by uuid
);
create unique index field_mapping_versions_unique
  on field_mapping_versions (definition_id, version);
create trigger field_mapping_versions_immutable_fields
  before delete on field_mapping_versions
  for each row execute function forbid_mutation();

-- ----------------------------------------------------- outreach & suppression

create table suppression_entries (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('email', 'phone', 'domain')),
  -- Lowercased / E.164 / registrable domain. Matching is never on raw input.
  normalized_value text not null,
  raw_value text not null default '',
  reason text not null check (reason in
    ('opt_out', 'hard_bounce', 'complaint', 'client_request', 'legal_request', 'manual')),
  detail text not null default '',
  -- Null = global. Non-null = suppressed for one client only.
  project_id uuid references projects(id),
  created_at timestamptz not null default now(),
  created_by uuid,
  -- Lifting a suppression is an admin act with a reason; the row never leaves.
  lifted_at timestamptz,
  lifted_by uuid,
  lift_reason text
);
create unique index suppression_entries_value
  on suppression_entries (scope, normalized_value,
    coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where lifted_at is null;

create table outreach_sequences (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id),
  workflow_run_id uuid references workflow_runs(id),
  subject_kind text not null default 'prospect'
    check (subject_kind in ('prospect', 'client', 'journalist', 'partner')),
  subject_ref text not null,
  recipient_email text not null,
  recipient_name text not null default '',
  status text not null default 'active'
    check (status in ('active', 'stopped_replied', 'stopped_opted_out',
                      'stopped_bounced', 'stopped_booked', 'stopped_manual',
                      'stopped_suppressed', 'completed')),
  stop_reason text,
  stopped_at timestamptz,
  current_step smallint not null default 0,
  max_steps smallint not null default 4,
  next_send_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index outreach_sequences_due_idx
  on outreach_sequences (next_send_at) where status = 'active';
create index outreach_sequences_project_idx on outreach_sequences (project_id, status);

create table outreach_messages (
  id uuid primary key default gen_random_uuid(),
  sequence_id uuid not null references outreach_sequences(id),
  step smallint not null,
  subject text not null,
  body text not null,
  -- The exact artifact version an approver saw. A changed draft invalidates it.
  body_hash text not null,
  approval_id uuid references workflow_approvals(id),
  status text not null default 'draft'
    check (status in ('draft', 'approved', 'sent', 'failed', 'suppressed', 'cancelled')),
  -- Every factual statement, with the evidence it rests on
  claims jsonb not null default '[]'::jsonb,
  evidence_ids uuid[] not null default '{}',
  provider_message_id text,
  sent_at timestamptz,
  error text,
  created_at timestamptz not null default now()
);
create unique index outreach_messages_step on outreach_messages (sequence_id, step);

-- -------------------------------------------------------- meetings & support

create table meeting_briefs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id),
  workflow_run_id uuid references workflow_runs(id),
  external_event_id text not null default '',
  title text not null,
  starts_at timestamptz,
  attendees jsonb not null default '[]'::jsonb,
  brief jsonb not null default '{}'::jsonb,
  -- Sources actually available when the brief was built, so a thin brief is
  -- explained rather than mysterious
  sources_used text[] not null default '{}',
  sources_missing text[] not null default '{}',
  delivered_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index meeting_briefs_event
  on meeting_briefs (project_id, external_event_id)
  where external_event_id <> '';

create table meeting_decisions (
  id uuid primary key default gen_random_uuid(),
  brief_id uuid references meeting_briefs(id),
  project_id uuid references projects(id),
  kind text not null check (kind in ('decision', 'action_item', 'question', 'relationship_note')),
  summary text not null,
  owner text not null default '',
  due_date date,
  related_workflow_key text,
  related_recommendation_id uuid,
  status text not null default 'open'
    check (status in ('open', 'in_progress', 'done', 'dropped')),
  evidence_source text not null default '',
  confidence numeric(4,3),
  created_at timestamptz not null default now()
);
create index meeting_decisions_open_idx
  on meeting_decisions (project_id, status) where status in ('open', 'in_progress');

create table support_requests (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id),
  workflow_run_id uuid references workflow_runs(id),
  sender_email text not null,
  subject text not null default '',
  body text not null,
  category text,
  urgency text check (urgency in ('low', 'normal', 'high', 'critical')),
  auto_response_allowed boolean not null default false,
  confidence numeric(4,3),
  resolution text not null default 'pending'
    check (resolution in ('pending', 'auto_answered', 'drafted', 'escalated', 'closed')),
  response_body text,
  escalation_reason text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index support_requests_open_idx
  on support_requests (project_id, resolution) where resolution = 'pending';

-- ------------------------------------------------------------------ billing

create table billing_events (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id),
  workflow_run_id uuid references workflow_runs(id),
  kind text not null check (kind in
    ('invoice_created', 'invoice_sent', 'reminder_sent', 'payment_received',
     'invoice_overdue', 'dispute_opened', 'escalated')),
  external_invoice_id text,
  -- Numeric, computed deterministically. An LLM never touches this column.
  amount_cents bigint,
  currency text not null default 'USD',
  due_date date,
  -- The contract line this came from, so an amount is always traceable
  contract_ref text not null default '',
  detail jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);
create index billing_events_project_idx on billing_events (project_id, occurred_at desc);
create unique index billing_events_invoice_kind
  on billing_events (external_invoice_id, kind)
  where external_invoice_id is not null;

-- --------------------------------------------------------------- test mode

create table workflow_fixtures (
  id uuid primary key default gen_random_uuid(),
  workflow_key text not null,
  name text not null,
  description text not null default '',
  -- The workflow's start input
  input jsonb not null default '{}'::jsonb,
  -- capability -> canned response, used by the fixture connector
  connector_responses jsonb not null default '{}'::jsonb,
  -- agent version -> canned output, so a demo never spends tokens
  agent_responses jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create unique index workflow_fixtures_name on workflow_fixtures (workflow_key, name);

-- What a test run WOULD have done. The point of test mode is this ledger.
create table workflow_test_actions (
  id uuid primary key default gen_random_uuid(),
  workflow_run_id uuid not null references workflow_runs(id),
  node_run_id uuid references node_runs(id),
  capability text not null,
  -- Redacted payload the live call would have carried
  would_have_sent jsonb not null default '{}'::jsonb,
  reason text not null default '',
  estimated_cost_micro_usd integer not null default 0,
  created_at timestamptz not null default now()
);
create index workflow_test_actions_run_idx on workflow_test_actions (workflow_run_id);

-- The one change to an existing table: additive, defaulted, reversible.
-- Production and test runs must be distinguishable in the database, not by
-- convention.
alter table workflow_runs
  add column mode text not null default 'live' check (mode in ('live', 'test'));
create index workflow_runs_mode_idx on workflow_runs (mode, started_at desc);

-- +migrate down
alter table workflow_runs drop column mode;
drop table workflow_test_actions;
drop table workflow_fixtures;
drop table billing_events;
drop table support_requests;
drop table meeting_decisions;
drop table meeting_briefs;
drop table outreach_messages;
drop table outreach_sequences;
drop table suppression_entries;
drop table field_mapping_versions;
drop table field_mapping_definitions;
drop table connector_sync_runs;
drop table connector_health_checks;
drop table connector_credentials;
drop table connector_connections;
drop table webhook_receipts;
drop table webhook_endpoints;
drop table trigger_fires;
drop table automation_triggers;
drop table event_delivery_attempts;
drop table event_subscriptions;
drop table domain_events;
