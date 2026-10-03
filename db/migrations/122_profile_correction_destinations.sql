-- +migrate up
-- Spec 147 (slice 3): where an approved correction goes.
--
-- A destination exists only because an operator recorded one, for one profile
-- URL, with a basis. It is never inferred from the page's domain and never
-- defaulted to the client's contact. Rows are append-only: replacing a
-- destination archives the active row and inserts a new one, so history is
-- never rewritten. At most one ACTIVE destination per (project, profile URL).
create table profile_correction_destinations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id),
  profile_url text not null check (profile_url ~ '^https?://'),
  -- client_editor: the client's own team applies the change on this page.
  -- publisher: the page's publisher accepts corrections on the client's behalf.
  kind text not null check (kind in ('client_editor', 'publisher')),
  recipient_name text not null check (length(trim(recipient_name)) > 0),
  email text not null check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  basis text not null check (length(trim(basis)) > 0),
  source_url text check (source_url is null or source_url ~ '^https?://'),
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  archived_by uuid references users(id),
  archive_reason text,
  constraint profile_correction_destinations_publisher_source
    check (kind <> 'publisher' or source_url is not null),
  constraint profile_correction_destinations_archive_complete
    check ((archived_at is null) = (archived_by is null))
);

create unique index profile_correction_destinations_one_active
  on profile_correction_destinations (project_id, profile_url)
  where archived_at is null;
create index profile_correction_destinations_project
  on profile_correction_destinations (project_id, profile_url, created_at desc);

-- Only the archive columns may change, once. Everything else is history.
create function profile_correction_destinations_append_only() returns trigger
language plpgsql as $$
begin
  if old.archived_at is not null then
    raise exception 'profile correction destination %: archived rows are immutable', old.id;
  end if;
  if new.id is distinct from old.id
    or new.project_id is distinct from old.project_id
    or new.profile_url is distinct from old.profile_url
    or new.kind is distinct from old.kind
    or new.recipient_name is distinct from old.recipient_name
    or new.email is distinct from old.email
    or new.basis is distinct from old.basis
    or new.source_url is distinct from old.source_url
    or new.created_by is distinct from old.created_by
    or new.created_at is distinct from old.created_at
  then
    raise exception 'profile correction destination %: only archiving is allowed', old.id;
  end if;
  return new;
end;
$$;

create trigger profile_correction_destinations_append_only
  before update on profile_correction_destinations
  for each row execute function profile_correction_destinations_append_only();

create trigger profile_correction_destinations_no_delete
  before delete on profile_correction_destinations
  for each row execute function forbid_mutation();

-- Requests learn their destination and a new waiting state: a publisher
-- destination needs the external-submission approval before drafting.
alter table profile_correction_requests
  add column destination_id uuid references profile_correction_destinations(id),
  add column routed_at timestamptz;

alter table profile_correction_requests
  drop constraint profile_correction_requests_status_check;
alter table profile_correction_requests
  add constraint profile_correction_requests_status_check check (status in (
    'awaiting_approval', 'approved', 'destination_required', 'awaiting_external_approval',
    'ready_to_draft', 'sent',
    'rejected', 'expired', 'withdrawn',
    'corrected', 'still_incorrect', 'needs_review', 'unreachable'));

drop index profile_correction_requests_one_open;
create unique index profile_correction_requests_one_open
  on profile_correction_requests (project_id, profile_url)
  where status in ('awaiting_approval', 'approved', 'destination_required',
                   'awaiting_external_approval', 'ready_to_draft', 'sent');

-- A routed request's destination must be its own project's, for its own
-- profile URL, and active at the moment it is attached.
create function profile_correction_requests_destination() returns trigger
language plpgsql as $$
begin
  if new.destination_id is not null and new.destination_id is distinct from old.destination_id then
    if not exists (
      select 1 from profile_correction_destinations d
      where d.id = new.destination_id
        and d.project_id = new.project_id
        and d.profile_url = new.profile_url
        and d.archived_at is null
    ) then
      raise exception 'profile correction %: destination % is not an active destination for this project and profile',
        new.id, new.destination_id;
    end if;
  end if;
  return new;
end;
$$;

create trigger profile_correction_requests_destination
  before update on profile_correction_requests
  for each row execute function profile_correction_requests_destination();

-- +migrate down
drop trigger if exists profile_correction_requests_destination on profile_correction_requests;
drop function if exists profile_correction_requests_destination();

drop index if exists profile_correction_requests_one_open;
create unique index profile_correction_requests_one_open
  on profile_correction_requests (project_id, profile_url)
  where status in ('awaiting_approval', 'approved', 'destination_required', 'ready_to_draft', 'sent');

-- Rows parked in the slice-3-only state return to the state that preceded it.
update profile_correction_requests set status = 'destination_required'
  where status = 'awaiting_external_approval';
alter table profile_correction_requests
  drop constraint profile_correction_requests_status_check;
alter table profile_correction_requests
  add constraint profile_correction_requests_status_check check (status in (
    'awaiting_approval', 'approved', 'destination_required', 'ready_to_draft', 'sent',
    'rejected', 'expired', 'withdrawn',
    'corrected', 'still_incorrect', 'needs_review', 'unreachable'));

alter table profile_correction_requests
  drop column if exists routed_at,
  drop column if exists destination_id;

drop trigger if exists profile_correction_destinations_no_delete on profile_correction_destinations;
drop trigger if exists profile_correction_destinations_append_only on profile_correction_destinations;
drop table if exists profile_correction_destinations;
drop function if exists profile_correction_destinations_append_only();
