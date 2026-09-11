-- Spec 131: client engagement readiness. The commercial record of a signed
-- client (term, fee, contract/payment state, market definition, permissions,
-- renewal), the client's immutable measurement packages (baseline and
-- remeasurements over frozen runs), the onboarding context items that turn
-- public evidence into confirmed client priorities, and the provenance a
-- paid work item must carry (observation → hypothesis → change → proof).
-- Reuses projects (the client), prospects (pre-sale history), markets +
-- exclusivity_agreements (territory), billing_events (invoice ledger),
-- tasks (the one work system), runs/mentions (evidence).

-- +migrate up
create table client_engagements (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id),
  -- Pre-sale provenance: the prospect record that became this client. Never
  -- copied — Touch 1, replies, corrections and the report stay on the prospect.
  prospect_id uuid references prospects(id),
  market_id uuid not null references markets(id),
  exclusivity_agreement_id uuid references exclusivity_agreements(id),
  previous_engagement_id uuid references client_engagements(id),
  primary_contact_id uuid references prospect_contacts(id),
  primary_contact_name text not null default '',
  owner_id uuid references users(id),

  starts_on date not null,
  ends_on date not null check (ends_on > starts_on),
  monthly_fee_usd numeric not null check (monthly_fee_usd >= 0),
  total_value_usd numeric not null check (total_value_usd >= 0),
  billing_cadence text not null default 'monthly'
    check (billing_cadence in ('monthly', 'upfront', 'custom')),
  payment_terms text not null default '',

  -- Contract execution stays outside the platform (no signature provider).
  -- The state is recorded truthfully; a signed contract carries a reference.
  contract_status text not null default 'draft'
    check (contract_status in ('draft', 'sent', 'signed', 'void')),
  contract_ref text,
  contract_signed_at timestamptz,
  constraint client_engagements_signed_has_ref check (
    contract_status != 'signed' or (contract_ref is not null and contract_signed_at is not null)
  ),

  -- Human-reviewed market boundary. Exclusivity never activates on an
  -- ambiguous name ("Grand Rapids" city vs metro vs county).
  market_definition text,
  market_definition_confirmed_at timestamptz,
  market_definition_confirmed_by uuid references users(id),

  scope_summary text not null default '',
  scope_exclusions text not null default '',

  stage text not null default 'signed'
    check (stage in ('signed', 'onboarding', 'active', 'renewal_review',
                     'renewed', 'completed', 'churned')),
  stage_changed_at timestamptz not null default now(),
  -- Founder override of the first-payment gate — a reason is the evidence.
  activation_override_reason text,

  renewal_status text not null default 'not_due'
    check (renewal_status in ('not_due', 'due', 'offered', 'renewed', 'declined', 'lapsed')),
  renewal_review_on date not null,

  -- Marketing permissions default to NO public use. Internal learning is
  -- separate from marketing permission.
  case_study_permission boolean not null default false,
  testimonial_permission boolean not null default false,
  logo_permission boolean not null default false,
  anonymized_data_permission boolean not null default false,

  closed_at timestamptz,
  close_reason text,
  -- A former client never re-enters cold prospecting before this date.
  cooldown_until date,

  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One live engagement per client project; renewals close the old row first.
create unique index client_engagements_one_live_per_project
  on client_engagements (project_id)
  where stage in ('signed', 'onboarding', 'active', 'renewal_review');
create index client_engagements_market_idx on client_engagements (market_id, stage);
create index client_engagements_prospect_idx on client_engagements (prospect_id);

-- Measurement packages. A frozen snapshot is the client's baseline (or a
-- remeasurement) over an immutable run: counts, denominators, per-question
-- rows, raw answer references, entity aliases and methodology versions as
-- they were at freeze time. It never drifts when aliases, prompts or
-- providers change later — the trigger below refuses to alter a snapshot.
create table engagement_measurements (
  id uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references client_engagements(id),
  project_id uuid not null references projects(id),
  role text not null check (role in ('baseline', 'midpoint', 'final', 'adhoc')),
  status text not null default 'planned'
    check (status in ('planned', 'frozen', 'non_comparable', 'failed', 'cancelled')),
  scheduled_for date,
  reason text not null default '',
  run_id uuid references runs(id),
  provider text,
  prompt_set_version_id uuid references prompt_set_versions(id),
  subject_company_id uuid references companies(id),
  competitor_company_ids uuid[] not null default '{}',
  snapshot jsonb,
  -- Comparability and comparison against the engagement baseline; null on
  -- the baseline itself.
  comparability jsonb,
  comparison jsonb,
  frozen_at timestamptz,
  status_detail text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  constraint engagement_measurements_frozen_has_snapshot check (
    status not in ('frozen', 'non_comparable') or (snapshot is not null and run_id is not null and frozen_at is not null)
  )
);
create index engagement_measurements_engagement_idx
  on engagement_measurements (engagement_id, role, created_at desc);
create unique index engagement_measurements_one_baseline
  on engagement_measurements (engagement_id) where role = 'baseline' and status = 'frozen';

create or replace function engagement_measurement_snapshot_immutable()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'engagement_measurements rows are never deleted (spec 131)';
  end if;
  if old.snapshot is not null and (
       new.snapshot is distinct from old.snapshot
    or new.run_id is distinct from old.run_id
    or new.frozen_at is distinct from old.frozen_at
    or new.prompt_set_version_id is distinct from old.prompt_set_version_id
    or new.provider is distinct from old.provider
    or new.subject_company_id is distinct from old.subject_company_id
    or new.competitor_company_ids is distinct from old.competitor_company_ids
  ) then
    raise exception 'a frozen measurement snapshot is immutable (spec 131)';
  end if;
  return new;
end $$;
create trigger engagement_measurements_immutable
  before update or delete on engagement_measurements
  for each row execute function engagement_measurement_snapshot_immutable();

-- Onboarding context: what the client told us, distinguished from what the
-- public evidence shows. "Eastown appears in the benchmark" ≠ "Ryan wants
-- Eastown". Access items track delegated access state only — this table
-- has no secret column by design; credentials never live in plain fields.
create table engagement_context_items (
  id uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references client_engagements(id),
  project_id uuid not null references projects(id),
  kind text not null check (kind in (
    'priority_area', 'property_type', 'client_focus', 'excluded_market',
    'competitor', 'excluded_competitor', 'identity', 'asset', 'access', 'note')),
  label text not null check (length(trim(label)) > 0),
  value jsonb not null default '{}'::jsonb,
  provenance text not null
    check (provenance in ('publicly_observed', 'client_confirmed', 'client_priority')),
  access_status text
    check (access_status in ('requested', 'granted', 'not_needed', 'declined', 'revoked')),
  source_ref text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint engagement_context_access_status check (
    (kind = 'access') = (access_status is not null)
  )
);
create index engagement_context_items_engagement_idx
  on engagement_context_items (engagement_id, kind);

-- The one work system gains the provenance a paid change must carry.
alter table tasks add column observation text;
alter table tasks add column hypothesis text;
alter table tasks add column confidence text
  check (confidence is null or confidence in ('high_confidence', 'medium_confidence', 'experimental'));
alter table tasks add column control text
  check (control is null or control in ('we_control', 'client_controls', 'third_party'));
alter table tasks add column scope text not null default 'in_scope'
  check (scope in ('in_scope', 'out_of_scope', 'needs_founder_review'));
alter table tasks add column client_approval text not null default 'not_required'
  check (client_approval in ('not_required', 'required', 'approved', 'rejected', 'edit_requested'));
alter table tasks add column blocked_reason text
  check (blocked_reason is null or blocked_reason in
    ('client_access', 'client_approval', 'client_input', 'third_party', 'internal'));
alter table tasks add column blocked_note text;
alter table tasks add column blocked_at timestamptz;
alter table tasks add column target_url text;
alter table tasks add column before_state text;
alter table tasks add column after_state text;
alter table tasks add column implemented_at timestamptz;
alter table tasks add column measurement_note text;
alter table tasks add constraint tasks_blocked_has_reason check (
  (blocked_reason is null) = (blocked_at is null)
);

-- Client decisions on work items are an append-only trail (who, what,
-- through which channel, when). The task carries the current state; this
-- table carries the history.
create table task_client_decisions (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id),
  project_id uuid not null references projects(id),
  decision text not null check (decision in ('approved', 'rejected', 'edit_requested')),
  channel text not null check (channel in ('portal', 'email', 'call', 'meeting', 'other')),
  note text not null default '',
  recorded_by uuid references users(id),
  decided_at timestamptz not null default now()
);
create index task_client_decisions_task_idx on task_client_decisions (task_id, decided_at desc);
create trigger task_client_decisions_immutable
  before update or delete on task_client_decisions
  for each row execute function forbid_mutation();

-- +migrate down
drop table task_client_decisions;
alter table tasks drop constraint tasks_blocked_has_reason;
alter table tasks drop column measurement_note;
alter table tasks drop column implemented_at;
alter table tasks drop column after_state;
alter table tasks drop column before_state;
alter table tasks drop column target_url;
alter table tasks drop column blocked_at;
alter table tasks drop column blocked_note;
alter table tasks drop column blocked_reason;
alter table tasks drop column client_approval;
alter table tasks drop column scope;
alter table tasks drop column control;
alter table tasks drop column confidence;
alter table tasks drop column hypothesis;
alter table tasks drop column observation;
drop table engagement_context_items;
drop trigger engagement_measurements_immutable on engagement_measurements;
drop function engagement_measurement_snapshot_immutable();
drop table engagement_measurements;
drop table client_engagements;
