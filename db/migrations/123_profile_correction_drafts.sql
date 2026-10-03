-- +migrate up
-- Spec 147 (slice 4): Gmail drafts of approved, routed corrections, the human
-- send confirmation, and the scheduled recheck.
--
-- One row per drafting ATTEMPT. At most one attempt per request is active
-- (pending → creating → created); creating a Gmail draft is never sending.
-- A request only becomes `sent` when a human confirms they sent exactly the
-- recorded draft, bound to the request hash, destination and draft id.
create table profile_correction_drafts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id),
  correction_request_id uuid not null references profile_correction_requests(id),
  destination_id uuid not null references profile_correction_destinations(id),
  request_sha256 text not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  attempt integer not null check (attempt > 0),
  status text not null default 'pending' check (status in (
    'pending', 'creating', 'created', 'sent',
    'failed', 'superseded', 'discarded', 'orphaned', 'outcome_unknown')),
  -- Exactly the engine key of the run this attempt starts.
  run_idempotency_key text not null unique,
  event_id uuid references domain_events(id),
  workflow_run_id uuid references workflow_runs(id),
  -- The deterministic email as rendered and validated, set once.
  email_version text,
  email jsonb,
  email_sha256 text check (email_sha256 is null or email_sha256 ~ '^[0-9a-f]{64}$'),
  from_address text,
  connection_id uuid references connector_connections(id),
  -- Gmail identifiers, set once when the draft exists.
  gmail_draft_id text,
  gmail_message_id text,
  gmail_thread_id text,
  drafted_at timestamptz,
  confirmed_at timestamptz,
  confirmed_by uuid references users(id),
  confirmation_approval_id uuid references workflow_approvals(id),
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (correction_request_id, attempt),
  constraint profile_correction_drafts_created_has_ids check (
    status not in ('created', 'sent') or (gmail_draft_id is not null and email is not null and drafted_at is not null)
  ),
  constraint profile_correction_drafts_sent_confirmed check (
    status <> 'sent' or (confirmed_at is not null and confirmation_approval_id is not null)
  )
);

-- Exactly one active draft attempt per correction request.
create unique index profile_correction_drafts_one_active
  on profile_correction_drafts (correction_request_id)
  where status in ('pending', 'creating', 'created');
create index profile_correction_drafts_status
  on profile_correction_drafts (status, created_at);

create function profile_correction_drafts_tenant() returns trigger
language plpgsql as $$
begin
  if not exists (
    select 1 from profile_correction_requests r
    where r.id = new.correction_request_id and r.project_id = new.project_id
  ) then
    raise exception 'profile correction draft %: request is not in project %', new.id, new.project_id;
  end if;
  if not exists (
    select 1 from profile_correction_destinations d
    where d.id = new.destination_id and d.project_id = new.project_id
  ) then
    raise exception 'profile correction draft %: destination is not in project %', new.id, new.project_id;
  end if;
  return new;
end;
$$;

create trigger profile_correction_drafts_tenant
  before insert on profile_correction_drafts
  for each row execute function profile_correction_drafts_tenant();

-- Identity never changes; the rendered email and Gmail ids are written once.
create function profile_correction_drafts_write_once() returns trigger
language plpgsql as $$
begin
  if new.id is distinct from old.id
    or new.project_id is distinct from old.project_id
    or new.correction_request_id is distinct from old.correction_request_id
    or new.destination_id is distinct from old.destination_id
    or new.request_sha256 is distinct from old.request_sha256
    or new.attempt is distinct from old.attempt
    or new.run_idempotency_key is distinct from old.run_idempotency_key
    or new.created_at is distinct from old.created_at
    or (old.email is not null and new.email is distinct from old.email)
    or (old.email_sha256 is not null and new.email_sha256 is distinct from old.email_sha256)
    or (old.gmail_draft_id is not null and new.gmail_draft_id is distinct from old.gmail_draft_id)
    or (old.gmail_message_id is not null and new.gmail_message_id is distinct from old.gmail_message_id)
  then
    raise exception 'profile correction draft %: identity, email and Gmail ids are write-once', old.id;
  end if;
  return new;
end;
$$;

create trigger profile_correction_drafts_write_once
  before update on profile_correction_drafts
  for each row execute function profile_correction_drafts_write_once();

create trigger profile_correction_drafts_no_delete
  before delete on profile_correction_drafts
  for each row execute function forbid_mutation();

-- Requests: the active draft, the send confirmation, and the recheck due time.
alter table profile_correction_requests
  add column active_draft_id uuid references profile_correction_drafts(id),
  add column sent_at timestamptz,
  add column sent_confirmed_by uuid references users(id),
  add column sent_approval_id uuid references workflow_approvals(id),
  add column sent_draft_id uuid references profile_correction_drafts(id),
  add column recheck_due_at timestamptz,
  add constraint profile_correction_requests_sent_complete check (
    status <> 'sent' or (sent_at is not null and sent_draft_id is not null and recheck_due_at is not null)
  );

alter table profile_correction_requests
  drop constraint profile_correction_requests_status_check;
alter table profile_correction_requests
  add constraint profile_correction_requests_status_check check (status in (
    'awaiting_approval', 'approved', 'destination_required', 'awaiting_external_approval',
    'ready_to_draft', 'awaiting_send_confirmation', 'sent',
    'rejected', 'expired', 'withdrawn',
    'corrected', 'still_incorrect', 'needs_review', 'unreachable'));

drop index profile_correction_requests_one_open;
create unique index profile_correction_requests_one_open
  on profile_correction_requests (project_id, profile_url)
  where status in ('awaiting_approval', 'approved', 'destination_required',
                   'awaiting_external_approval', 'ready_to_draft',
                   'awaiting_send_confirmation', 'sent');

-- +migrate down
drop index if exists profile_correction_requests_one_open;
create unique index profile_correction_requests_one_open
  on profile_correction_requests (project_id, profile_url)
  where status in ('awaiting_approval', 'approved', 'destination_required',
                   'awaiting_external_approval', 'ready_to_draft', 'sent');

-- A request parked in the slice-4-only state returns to the state before it.
update profile_correction_requests set status = 'ready_to_draft'
  where status = 'awaiting_send_confirmation';
alter table profile_correction_requests
  drop constraint profile_correction_requests_status_check;
alter table profile_correction_requests
  add constraint profile_correction_requests_status_check check (status in (
    'awaiting_approval', 'approved', 'destination_required', 'awaiting_external_approval',
    'ready_to_draft', 'sent',
    'rejected', 'expired', 'withdrawn',
    'corrected', 'still_incorrect', 'needs_review', 'unreachable'));

alter table profile_correction_requests
  drop constraint if exists profile_correction_requests_sent_complete,
  drop column if exists recheck_due_at,
  drop column if exists sent_draft_id,
  drop column if exists sent_approval_id,
  drop column if exists sent_confirmed_by,
  drop column if exists sent_at,
  drop column if exists active_draft_id;

drop trigger if exists profile_correction_drafts_no_delete on profile_correction_drafts;
drop trigger if exists profile_correction_drafts_write_once on profile_correction_drafts;
drop trigger if exists profile_correction_drafts_tenant on profile_correction_drafts;
drop table if exists profile_correction_drafts;
drop function if exists profile_correction_drafts_write_once();
drop function if exists profile_correction_drafts_tenant();
