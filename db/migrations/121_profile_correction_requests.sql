-- +migrate up
-- Spec 147 (slice 2): deterministic profile correction requests.
--
-- One row per correction request a profile-correction run builds from Spec
-- 146's validated contradiction pairs. The request content is immutable and
-- content-hashed; only the lifecycle columns move. At most one OPEN request
-- exists per (project, profile URL) — the partial unique index below is the
-- concurrency-safe duplicate guard. Destination, drafting and recheck columns
-- arrive with the slices that implement them.
create table profile_correction_requests (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id),
  workflow_run_id uuid not null unique references workflow_runs(id),
  check_request_id uuid references profile_check_requests(id),
  context_item_id uuid references engagement_context_items(id),
  profile_url text not null check (profile_url ~ '^https?://'),
  request_version text not null check (length(trim(request_version)) > 0),
  request jsonb not null,
  request_sha256 text not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  before_source_artifact_id uuid not null references source_artifacts(id),
  before_sha256 text not null,
  evidence_packet_id uuid not null references evidence_packets(id),
  item_count integer not null check (item_count > 0),
  max_severity text not null check (max_severity in ('low', 'medium', 'high', 'critical')),
  status text not null default 'awaiting_approval' check (status in (
    'awaiting_approval', 'approved', 'destination_required', 'ready_to_draft', 'sent',
    'rejected', 'expired', 'withdrawn',
    'corrected', 'still_incorrect', 'needs_review', 'unreachable')),
  -- The approval decision, bound to request_sha256 when it was made.
  approval_id uuid references workflow_approvals(id),
  decided_by uuid references users(id),
  decided_at timestamptz,
  decision_rationale text,
  -- Why a request closed without approval (withdrawn, expired).
  closed_by uuid references users(id),
  closed_at timestamptz,
  closed_reason text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profile_correction_requests_decided check (
    status not in ('approved', 'rejected') or (decided_at is not null and approval_id is not null)
  ),
  constraint profile_correction_requests_closed check (
    status not in ('withdrawn', 'expired') or (closed_at is not null and closed_reason is not null)
  )
);

-- One open correction per profile per client (spec 147 §8.1).
create unique index profile_correction_requests_one_open
  on profile_correction_requests (project_id, profile_url)
  where status in ('awaiting_approval', 'approved', 'destination_required', 'ready_to_draft', 'sent');
create index profile_correction_requests_project
  on profile_correction_requests (project_id, created_at desc);

-- Tenant safety at the database: every referenced row must belong to the
-- request's project. A correction can never point at another client's run,
-- page, packet, queue row or context item.
create function profile_correction_requests_tenant() returns trigger
language plpgsql as $$
begin
  if not exists (select 1 from workflow_runs where id = new.workflow_run_id and project_id = new.project_id) then
    raise exception 'profile correction % : workflow run is not in project %', new.id, new.project_id;
  end if;
  if not exists (select 1 from source_artifacts where id = new.before_source_artifact_id and project_id = new.project_id) then
    raise exception 'profile correction % : source artifact is not in project %', new.id, new.project_id;
  end if;
  if not exists (select 1 from evidence_packets where id = new.evidence_packet_id and project_id = new.project_id) then
    raise exception 'profile correction % : evidence packet is not in project %', new.id, new.project_id;
  end if;
  if new.check_request_id is not null and not exists (
    select 1 from profile_check_requests where id = new.check_request_id and project_id = new.project_id
  ) then
    raise exception 'profile correction % : check request is not in project %', new.id, new.project_id;
  end if;
  if new.context_item_id is not null and not exists (
    select 1 from engagement_context_items where id = new.context_item_id and project_id = new.project_id
  ) then
    raise exception 'profile correction % : context item is not in project %', new.id, new.project_id;
  end if;
  return new;
end;
$$;

create trigger profile_correction_requests_tenant
  before insert on profile_correction_requests
  for each row execute function profile_correction_requests_tenant();

-- The request is evidence of exactly what a human approved: its content and
-- identity never change. Lifecycle columns may.
create function profile_correction_requests_immutable() returns trigger
language plpgsql as $$
begin
  if new.id is distinct from old.id
    or new.project_id is distinct from old.project_id
    or new.workflow_run_id is distinct from old.workflow_run_id
    or new.check_request_id is distinct from old.check_request_id
    or new.context_item_id is distinct from old.context_item_id
    or new.profile_url is distinct from old.profile_url
    or new.request_version is distinct from old.request_version
    or new.request is distinct from old.request
    or new.request_sha256 is distinct from old.request_sha256
    or new.before_source_artifact_id is distinct from old.before_source_artifact_id
    or new.before_sha256 is distinct from old.before_sha256
    or new.evidence_packet_id is distinct from old.evidence_packet_id
    or new.item_count is distinct from old.item_count
    or new.max_severity is distinct from old.max_severity
    or new.created_by is distinct from old.created_by
    or new.created_at is distinct from old.created_at
  then
    raise exception 'profile correction %: request content is immutable', old.id;
  end if;
  return new;
end;
$$;

create trigger profile_correction_requests_immutable
  before update on profile_correction_requests
  for each row execute function profile_correction_requests_immutable();

create trigger profile_correction_requests_no_delete
  before delete on profile_correction_requests
  for each row execute function forbid_mutation();

-- Slice 1 left this for the table it references.
alter table profile_check_requests
  add constraint profile_check_requests_correction_fk
  foreign key (correction_request_id) references profile_correction_requests(id);

-- +migrate down
alter table profile_check_requests
  drop constraint if exists profile_check_requests_correction_fk;
drop trigger if exists profile_correction_requests_no_delete on profile_correction_requests;
drop trigger if exists profile_correction_requests_immutable on profile_correction_requests;
drop trigger if exists profile_correction_requests_tenant on profile_correction_requests;
drop table if exists profile_correction_requests;
drop function if exists profile_correction_requests_immutable();
drop function if exists profile_correction_requests_tenant();
