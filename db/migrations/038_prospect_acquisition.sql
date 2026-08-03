-- +migrate up
-- Spec 032: prospect acquisition vertical slice. A market launch holds
-- prospects; a prospect links to existing run data through its canonical
-- company; findings compare verified real-world authority against measured
-- AI visibility and require human approval before anything becomes
-- client-facing. Nothing here sends, scrapes, or stores a metric that the
-- scoring engine did not already store — benchmark numbers are read from
-- `scores`/`mentions` at render time, never duplicated.

create table market_launches (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  market_id uuid not null references markets(id),
  property_category text,
  price_segment text,
  customer_segment text,
  service_category text,
  target_prospect_count int check (target_prospect_count is null or target_prospect_count > 0),
  owner_id uuid references users(id),
  status text not null default 'researching' check (status in
    ('researching', 'benchmarking', 'outreach_ready', 'outreach_active',
     'in_conversation', 'partner_selected', 'protected', 'paused', 'closed')),
  priority int not null default 2 check (priority between 1 and 3),
  starts_on date,
  target_close_on date,
  exclusivity_model text,
  notes text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  archived_at timestamptz
);

create unique index market_launches_active_name_unique
  on market_launches (lower(name)) where archived_at is null;
create index market_launches_market_idx on market_launches (market_id);
create index market_launches_status_idx on market_launches (status) where archived_at is null;

-- The 17-stage pipeline is ordered; ordering lives in lib/prospects/constants.ts
-- and the transition guards live in the service — the column only vouches
-- that a stage is a known one.
create table prospects (
  id uuid primary key default gen_random_uuid(),
  launch_id uuid not null references market_launches(id),
  business_name text not null,
  prospect_type text not null default 'team' check (prospect_type in
    ('brokerage', 'team', 'individual_agent', 'developer', 'new_dev_marketing')),
  company_id uuid references companies(id),
  brokerage_affiliation text,
  team_leader text,
  website text,
  email text,
  phone text,
  socials jsonb not null default '{}',
  neighborhoods text[] not null default '{}',
  specialties text[] not null default '{}',
  price_segment text,
  est_transaction_volume_usd bigint check (est_transaction_volume_usd is null or est_transaction_volume_usd >= 0),
  est_team_size int check (est_team_size is null or est_team_size > 0),
  source text not null default 'manual' check (source in ('manual', 'csv', 'referral', 'research')),
  -- field name -> 'verified' | 'publicly_sourced' | 'estimated' | 'manual' | 'ai_inferred'
  field_provenance jsonb not null default '{}',
  owner_id uuid references users(id),
  qualification_score int check (qualification_score is null or qualification_score between 0 and 100),
  relationship_strength text not null default 'none' check (relationship_strength in
    ('none', 'weak', 'warm', 'strong')),
  stage text not null default 'identified' check (stage in
    ('identified', 'researching', 'benchmarking', 'qualified', 'outreach_ready',
     'contacted', 'replied', 'audit_sent', 'audit_viewed', 'discovery_scheduled',
     'discovery_completed', 'proposal_sent', 'negotiation', 'verbal_yes',
     'contracted', 'closed_lost', 'waitlisted', 'conflict_blocked')),
  next_action text,
  next_action_on date,
  do_not_contact boolean not null default false,
  do_not_contact_reason text,
  conflict_status text not null default 'unchecked' check (conflict_status in
    ('unchecked', 'clear', 'possible', 'partial', 'direct', 'blocked', 'override')),
  last_exclusivity_check_id uuid references exclusivity_checks(id),
  notes text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create unique index prospects_active_name_per_launch_unique
  on prospects (launch_id, lower(business_name)) where archived_at is null;
create index prospects_launch_idx on prospects (launch_id);
create index prospects_stage_idx on prospects (stage) where archived_at is null;
create index prospects_owner_idx on prospects (owner_id) where archived_at is null;
create index prospects_company_idx on prospects (company_id);

create table prospect_authority_signals (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid not null references prospects(id),
  kind text not null check (kind in
    ('transaction_volume', 'transaction_count', 'avg_deal_value', 'notable_listing',
     'notable_sale', 'years_in_market', 'team_size', 'ranking', 'award',
     'press_mention', 'specialization', 'review_footprint', 'market_report',
     'video_content', 'speaking', 'other')),
  label text not null,
  value_number numeric,
  value_text text,
  source_url text,
  provenance text not null check (provenance in
    ('verified', 'publicly_sourced', 'estimated', 'manual', 'ai_inferred')),
  confidence real check (confidence is null or (confidence >= 0 and confidence <= 1)),
  notes text,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);

create index prospect_authority_signals_prospect_idx
  on prospect_authority_signals (prospect_id);

-- A benchmark is a LINK to measurement the platform already made, not a copy
-- of it. Metrics render from `scores`/`mentions` for (run_id, company_id).
create table prospect_benchmarks (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid not null references prospects(id),
  run_id uuid not null references runs(id),
  company_id uuid not null references companies(id),
  note text,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);

create unique index prospect_benchmarks_unique on prospect_benchmarks (prospect_id, run_id);
create index prospect_benchmarks_run_idx on prospect_benchmarks (run_id);

create table prospect_findings (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid not null references prospects(id),
  benchmark_id uuid not null references prospect_benchmarks(id),
  kind text not null check (kind in
    ('authority_visibility_gap', 'competitor_contrast', 'absence', 'citation_gap')),
  title text not null,
  explanation text not null,
  metrics jsonb not null default '{}',
  signal_ids uuid[] not null default '{}',
  response_ids uuid[] not null default '{}',
  competitor_company_ids uuid[] not null default '{}',
  confidence real check (confidence is null or (confidence >= 0 and confidence <= 1)),
  severity text not null default 'medium' check (severity in ('low', 'medium', 'high')),
  business_relevance text,
  suggested_angle text,
  rank_score real,
  generator_version text not null,
  status text not null default 'candidate' check (status in
    ('candidate', 'approved', 'rejected', 'archived')),
  is_primary boolean not null default false,
  reviewed_by uuid references users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  -- An approved finding without response evidence is an unsupported claim;
  -- the database refuses it regardless of what the service forgets.
  constraint prospect_findings_approved_need_evidence
    check (status != 'approved' or cardinality(response_ids) > 0)
);

create index prospect_findings_prospect_idx on prospect_findings (prospect_id);
create unique index prospect_findings_one_primary
  on prospect_findings (prospect_id) where is_primary and status = 'approved';

create table prospect_audits (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid not null references prospects(id),
  finding_id uuid not null references prospect_findings(id),
  headline text not null,
  snapshot jsonb not null,
  status text not null default 'draft' check (status in ('draft', 'published', 'revoked')),
  access_token text,
  expires_at timestamptz,
  published_by uuid references users(id),
  published_at timestamptz,
  revoked_by uuid references users(id),
  revoked_at timestamptz,
  revoke_reason text,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);

create unique index prospect_audits_token_unique
  on prospect_audits (access_token) where access_token is not null;
create index prospect_audits_prospect_idx on prospect_audits (prospect_id);

-- What a prospect saw is what we published: once published, only revocation
-- may touch the row. Content edits mean revoke + publish a new audit.
create function forbid_published_prospect_audit_mutation() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'DELETE on a prospect audit is forbidden: audits are archived by revocation';
  end if;
  if old.status = 'published' then
    if new.snapshot is distinct from old.snapshot
      or new.headline is distinct from old.headline
      or new.finding_id is distinct from old.finding_id
      or new.prospect_id is distinct from old.prospect_id
      or new.access_token is distinct from old.access_token
      or new.published_at is distinct from old.published_at
      or new.published_by is distinct from old.published_by then
      raise exception 'published prospect audits are immutable except for revocation (spec 032)';
    end if;
  end if;
  return new;
end;
$$;

create trigger prospect_audits_published_lock
  before update or delete on prospect_audits
  for each row execute function forbid_published_prospect_audit_mutation();

create table prospect_audit_views (
  id uuid primary key default gen_random_uuid(),
  audit_id uuid not null references prospect_audits(id),
  viewed_at timestamptz not null default now(),
  ip text,
  user_agent text,
  is_internal boolean not null default false
);

create index prospect_audit_views_audit_idx on prospect_audit_views (audit_id, viewed_at desc);

create trigger prospect_audit_views_immutable
  before update or delete on prospect_audit_views
  for each row execute function forbid_mutation();

create table outreach_drafts (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid not null references prospects(id),
  finding_id uuid not null references prospect_findings(id),
  channel text not null check (channel in
    ('email', 'linkedin_message', 'followup_email', 'warm_intro')),
  version int not null default 1 check (version > 0),
  parent_id uuid references outreach_drafts(id),
  subject text,
  body text not null,
  tone text,
  cta text,
  generated_by text not null check (generated_by in ('system', 'operator')),
  model text,
  prompt_version text,
  status text not null default 'draft' check (status in ('draft', 'approved', 'superseded')),
  approved_by uuid references users(id),
  approved_at timestamptz,
  sent_recorded_at timestamptz,
  sent_recorded_by uuid references users(id),
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);

create index outreach_drafts_prospect_idx on outreach_drafts (prospect_id, channel, version desc);

-- The approved text is what a human signed off on. Edits create a new
-- version; the approved row may only be superseded or marked sent.
create function forbid_approved_outreach_draft_mutation() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'DELETE on an outreach draft is forbidden: drafts are versioned, not erased';
  end if;
  if old.status = 'approved' then
    if new.subject is distinct from old.subject
      or new.body is distinct from old.body
      or new.cta is distinct from old.cta
      or new.tone is distinct from old.tone
      or new.channel is distinct from old.channel
      or new.prospect_id is distinct from old.prospect_id
      or new.finding_id is distinct from old.finding_id
      or new.approved_by is distinct from old.approved_by
      or new.approved_at is distinct from old.approved_at then
      raise exception 'approved outreach drafts are immutable: edit by creating a new version (spec 032)';
    end if;
  end if;
  return new;
end;
$$;

create trigger outreach_drafts_approved_lock
  before update or delete on outreach_drafts
  for each row execute function forbid_approved_outreach_draft_mutation();

create table screen_recording_plans (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid not null references prospects(id),
  finding_id uuid not null references prospect_findings(id),
  script text not null,
  storyboard jsonb not null default '[]',
  estimated_duration_seconds int check (estimated_duration_seconds is null or estimated_duration_seconds > 0),
  claims_to_verify jsonb not null default '[]',
  cta text,
  status text not null default 'script_ready' check (status in
    ('not_started', 'script_ready', 'recorded', 'sent', 'viewed', 'replied', 'meeting_booked')),
  generator_version text not null,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index screen_recording_plans_prospect_idx on screen_recording_plans (prospect_id);

create table prospect_stage_history (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid not null references prospects(id),
  from_stage text not null,
  to_stage text not null,
  reason text,
  exclusivity_check_id uuid references exclusivity_checks(id),
  changed_by uuid references users(id),
  changed_at timestamptz not null default now()
);

create index prospect_stage_history_prospect_idx
  on prospect_stage_history (prospect_id, changed_at desc);

create trigger prospect_stage_history_immutable
  before update or delete on prospect_stage_history
  for each row execute function forbid_mutation();

-- The per-prospect timeline. actor_id is nullable because anonymous audit
-- views are activities too.
create table prospect_activities (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid not null references prospects(id),
  kind text not null,
  detail jsonb not null default '{}',
  actor_id uuid references users(id),
  occurred_at timestamptz not null default now()
);

create index prospect_activities_prospect_idx
  on prospect_activities (prospect_id, occurred_at desc);

create trigger prospect_activities_immutable
  before update or delete on prospect_activities
  for each row execute function forbid_mutation();

-- +migrate down
drop table prospect_activities;
drop table prospect_stage_history;
drop table screen_recording_plans;
drop trigger outreach_drafts_approved_lock on outreach_drafts;
drop function forbid_approved_outreach_draft_mutation();
drop table outreach_drafts;
drop table prospect_audit_views;
drop trigger prospect_audits_published_lock on prospect_audits;
drop function forbid_published_prospect_audit_mutation();
drop table prospect_audits;
drop table prospect_findings;
drop table prospect_benchmarks;
drop table prospect_authority_signals;
drop table prospects;
drop table market_launches;
