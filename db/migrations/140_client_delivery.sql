-- Spec 154: client onboarding and 90-day delivery. Additive only.
-- Numbered 140 so it never collides with the unmerged 119–125 (spec 147)
-- and 126–134 (spec 151) branches.
--
-- Records the four contract-critical facts that had no home: the client's
-- decisions on non-task subjects (question set, protocol, roadmap), the
-- accepted measurement protocol, what we told the client each week, and the
-- check-ins. External (non-OpenAI) measurements enter only as labelled,
-- hashed manual imports. Plan items gain dates and dependencies.

-- +migrate up
create table engagement_protocols (
  id uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references client_engagements(id),
  project_id uuid not null references projects(id),
  version int not null check (version > 0),
  prompt_set_version_id uuid not null references prompt_set_versions(id),
  provider text not null check (length(trim(provider)) > 0),
  model text not null check (length(trim(model)) > 0),
  geographic_context text not null default '',
  repetitions int not null check (repetitions between 1 and 20),
  baseline_window text not null default '',
  final_window text not null default '',
  recommendation_rubric text not null default '',
  comparison_rules text not null default '',
  caveats text not null default '',
  adjudication text not null default '',
  success_criteria text not null default '',
  entity_aliases text[] not null default '{}',
  external_sources text not null default '',
  status text not null default 'draft' check (status in ('draft', 'accepted', 'superseded')),
  accepted_at timestamptz,
  accepted_by_name text,
  accepted_channel text check (accepted_channel is null or accepted_channel in ('portal', 'email', 'call', 'meeting', 'other')),
  accepted_recorded_by uuid references users(id),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (engagement_id, version),
  constraint engagement_protocols_accepted_complete check (
    status = 'draft' or (accepted_at is not null and accepted_by_name is not null and accepted_channel is not null)
  )
);
create unique index engagement_protocols_one_accepted
  on engagement_protocols (engagement_id) where status = 'accepted';

create or replace function engagement_protocol_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'engagement_protocols rows are never deleted (spec 154)';
  end if;
  if old.status = 'draft' then
    return new;
  end if;
  -- Accepted/superseded: the agreed text is frozen. The only legal change is
  -- accepted -> superseded when a newer version is accepted.
  if (old.status = 'accepted' and new.status = 'superseded')
     and row(new.engagement_id, new.project_id, new.version, new.prompt_set_version_id, new.provider, new.model,
             new.geographic_context, new.repetitions, new.baseline_window, new.final_window, new.recommendation_rubric,
             new.comparison_rules, new.caveats, new.adjudication, new.success_criteria, new.entity_aliases,
             new.external_sources, new.accepted_at, new.accepted_by_name, new.accepted_channel, new.accepted_recorded_by)
       is not distinct from
         row(old.engagement_id, old.project_id, old.version, old.prompt_set_version_id, old.provider, old.model,
             old.geographic_context, old.repetitions, old.baseline_window, old.final_window, old.recommendation_rubric,
             old.comparison_rules, old.caveats, old.adjudication, old.success_criteria, old.entity_aliases,
             old.external_sources, old.accepted_at, old.accepted_by_name, old.accepted_channel, old.accepted_recorded_by) then
    return new;
  end if;
  raise exception 'an accepted measurement protocol is immutable (spec 154)';
end $$;
create trigger engagement_protocols_guard
  before update or delete on engagement_protocols
  for each row execute function engagement_protocol_guard();

-- Client decisions on non-task subjects. Append-only.
create table engagement_client_decisions (
  id uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references client_engagements(id),
  project_id uuid not null references projects(id),
  subject_kind text not null check (subject_kind in
    ('question_set', 'protocol', 'roadmap', 'intake', 'final_review', 'other')),
  subject_ref text not null default '',
  decision text not null check (decision in ('approved', 'changes_requested', 'rejected', 'acknowledged')),
  channel text not null check (channel in ('portal', 'email', 'call', 'meeting', 'other')),
  client_actor text not null check (length(trim(client_actor)) > 0),
  note text not null default '',
  snapshot jsonb not null default '{}'::jsonb,
  recorded_by uuid references users(id),
  decided_at timestamptz not null default now()
);
create index engagement_client_decisions_idx
  on engagement_client_decisions (engagement_id, subject_kind, decided_at desc);
create trigger engagement_client_decisions_immutable
  before update or delete on engagement_client_decisions
  for each row execute function forbid_mutation();

-- What we told the client. Draft is editable; sent is frozen forever.
create table engagement_updates (
  id uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references client_engagements(id),
  project_id uuid not null references projects(id),
  kind text not null check (kind in ('welcome', 'weekly', 'final_review')),
  period_start date,
  period_end date,
  body jsonb not null,
  status text not null default 'draft' check (status in ('draft', 'sent', 'discarded')),
  channel text check (channel is null or channel in ('portal', 'email', 'call', 'meeting', 'other')),
  sent_at timestamptz,
  sent_by uuid references users(id),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint engagement_updates_sent_complete check (
    status <> 'sent' or (sent_at is not null and channel is not null)
  )
);
create index engagement_updates_idx on engagement_updates (engagement_id, kind, created_at desc);
create unique index engagement_updates_one_draft
  on engagement_updates (engagement_id, kind) where status = 'draft';

create or replace function engagement_update_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'engagement_updates rows are never deleted (spec 154)';
  end if;
  if old.status <> 'draft' then
    raise exception 'a sent or discarded client update is immutable (spec 154)';
  end if;
  return new;
end $$;
create trigger engagement_updates_guard
  before update or delete on engagement_updates
  for each row execute function engagement_update_guard();

create table engagement_meetings (
  id uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references client_engagements(id),
  project_id uuid not null references projects(id),
  kind text not null default 'checkin' check (kind in ('kickoff', 'checkin', 'final_review')),
  scheduled_for timestamptz not null,
  agenda text not null default '',
  status text not null default 'planned' check (status in ('planned', 'held', 'cancelled')),
  notes text not null default '',
  action_items jsonb not null default '[]'::jsonb,
  client_visible boolean not null default true,
  held_at timestamptz,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index engagement_meetings_idx on engagement_meetings (engagement_id, scheduled_for);
create trigger engagement_meetings_no_delete
  before delete on engagement_meetings
  for each row execute function forbid_mutation();

-- External instruments (e.g. a third-party brand-radar product). Manual,
-- labelled, hashed. Never blended into the OpenAI snapshot numbers.
create table external_measurements (
  id uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references client_engagements(id),
  project_id uuid not null references projects(id),
  provider_label text not null check (length(trim(provider_label)) > 0),
  instrument text not null default '',
  source_kind text not null default 'manual_import' check (source_kind in ('manual_import')),
  reference_url text,
  captured_from date not null,
  captured_to date not null check (captured_to >= captured_from),
  prompt_count int check (prompt_count is null or prompt_count >= 0),
  summary text not null default '',
  raw_export text not null,
  raw_sha256 text not null,
  distinguishes_recommendation text not null default 'unknown'
    check (distinguishes_recommendation in ('yes', 'no', 'unknown')),
  qa_status text not null default 'pending' check (qa_status in ('pending', 'verified', 'rejected')),
  qa_note text not null default '',
  qa_by uuid references users(id),
  qa_at timestamptz,
  client_visible boolean not null default false,
  imported_by uuid references users(id),
  created_at timestamptz not null default now(),
  constraint external_measurements_visible_verified check (not client_visible or qa_status = 'verified')
);
create index external_measurements_idx on external_measurements (engagement_id, created_at desc);

create or replace function external_measurement_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'external_measurements rows are never deleted (spec 154)';
  end if;
  if row(new.engagement_id, new.project_id, new.provider_label, new.instrument, new.source_kind, new.reference_url,
         new.captured_from, new.captured_to, new.prompt_count, new.summary, new.raw_export, new.raw_sha256,
         new.distinguishes_recommendation, new.imported_by, new.created_at)
     is distinct from
     row(old.engagement_id, old.project_id, old.provider_label, old.instrument, old.source_kind, old.reference_url,
         old.captured_from, old.captured_to, old.prompt_count, old.summary, old.raw_export, old.raw_sha256,
         old.distinguishes_recommendation, old.imported_by, old.created_at) then
    raise exception 'an imported external measurement is immutable; only QA status and visibility change (spec 154)';
  end if;
  return new;
end $$;
create trigger external_measurements_guard
  before update or delete on external_measurements
  for each row execute function external_measurement_guard();

alter table plan_items add column due_on date;
alter table plan_items add column depends_on uuid[] not null default '{}';
alter table plan_items add column proof_url text;

alter table task_client_decisions add column client_actor text;
alter table task_client_decisions add column wording_snapshot text;
alter table task_client_decisions add column target_url_snapshot text;

-- +migrate down
alter table task_client_decisions drop column target_url_snapshot;
alter table task_client_decisions drop column wording_snapshot;
alter table task_client_decisions drop column client_actor;
alter table plan_items drop column proof_url;
alter table plan_items drop column depends_on;
alter table plan_items drop column due_on;
drop trigger external_measurements_guard on external_measurements;
drop function external_measurement_guard();
drop table external_measurements;
drop trigger engagement_meetings_no_delete on engagement_meetings;
drop table engagement_meetings;
drop trigger engagement_updates_guard on engagement_updates;
drop function engagement_update_guard();
drop table engagement_updates;
drop trigger engagement_client_decisions_immutable on engagement_client_decisions;
drop table engagement_client_decisions;
drop trigger engagement_protocols_guard on engagement_protocols;
drop function engagement_protocol_guard();
drop table engagement_protocols;
