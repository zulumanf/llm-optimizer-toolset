-- +migrate up
-- Spec 147 (slice 5): the result of a sent correction's 14-day recheck.
--
-- One immutable result per correction (one recheck is scheduled per sent
-- correction). It records what was fetched, how the page compared with the
-- before-page evidence, every original item's classification and the overall
-- result, content-hashed and versioned. The correction request itself is never
-- rewritten: only its lifecycle status moves to the result.
create table profile_correction_rechecks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id),
  correction_request_id uuid not null unique references profile_correction_requests(id),
  check_request_id uuid references profile_check_requests(id),
  workflow_run_id uuid not null unique references workflow_runs(id),
  profile_url text not null check (profile_url ~ '^https?://'),
  request_sha256 text not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  before_source_artifact_id uuid not null references source_artifacts(id),
  after_source_artifact_id uuid references source_artifacts(id),
  evidence_packet_id uuid references evidence_packets(id),
  http_status integer,
  page_state text not null check (page_state in ('unreachable', 'unchanged', 'previously_seen', 'changed')),
  result text not null check (result in ('corrected', 'still_incorrect', 'needs_review', 'unreachable')),
  result_version text not null check (length(trim(result_version)) > 0),
  result_detail jsonb not null,
  result_sha256 text not null check (result_sha256 ~ '^[0-9a-f]{64}$'),
  checked_at timestamptz not null default now(),
  constraint profile_correction_rechecks_unreachable check ((page_state = 'unreachable') = (result = 'unreachable')),
  constraint profile_correction_rechecks_after check (page_state = 'unreachable' or after_source_artifact_id is not null)
);
create index profile_correction_rechecks_project on profile_correction_rechecks (project_id, checked_at desc);

create function profile_correction_rechecks_tenant() returns trigger
language plpgsql as $$
begin
  if not exists (
    select 1 from profile_correction_requests r
    where r.id = new.correction_request_id and r.project_id = new.project_id
      and r.profile_url = new.profile_url and r.request_sha256 = new.request_sha256
      and r.before_source_artifact_id = new.before_source_artifact_id
  ) then
    raise exception 'profile correction recheck %: does not match a correction request of project %', new.id, new.project_id;
  end if;
  if not exists (select 1 from workflow_runs where id = new.workflow_run_id and project_id = new.project_id) then
    raise exception 'profile correction recheck %: workflow run is not in project %', new.id, new.project_id;
  end if;
  if new.after_source_artifact_id is not null and not exists (
    select 1 from source_artifacts where id = new.after_source_artifact_id and project_id = new.project_id
  ) then
    raise exception 'profile correction recheck %: after-page artifact is not in project %', new.id, new.project_id;
  end if;
  if new.evidence_packet_id is not null and not exists (
    select 1 from evidence_packets where id = new.evidence_packet_id and project_id = new.project_id
  ) then
    raise exception 'profile correction recheck %: evidence packet is not in project %', new.id, new.project_id;
  end if;
  if new.check_request_id is not null and not exists (
    select 1 from profile_check_requests where id = new.check_request_id and project_id = new.project_id
  ) then
    raise exception 'profile correction recheck %: check request is not in project %', new.id, new.project_id;
  end if;
  return new;
end;
$$;

create trigger profile_correction_rechecks_tenant
  before insert on profile_correction_rechecks
  for each row execute function profile_correction_rechecks_tenant();

-- A recheck result is evidence: insert-only.
create trigger profile_correction_rechecks_immutable
  before update or delete on profile_correction_rechecks
  for each row execute function forbid_mutation();

alter table profile_correction_requests
  add column recheck_run_id uuid references workflow_runs(id),
  add column recheck_result_id uuid references profile_correction_rechecks(id),
  add column rechecked_at timestamptz;

-- +migrate down
alter table profile_correction_requests
  drop column if exists rechecked_at,
  drop column if exists recheck_result_id,
  drop column if exists recheck_run_id;
drop trigger if exists profile_correction_rechecks_immutable on profile_correction_rechecks;
drop trigger if exists profile_correction_rechecks_tenant on profile_correction_rechecks;
drop table if exists profile_correction_rechecks;
drop function if exists profile_correction_rechecks_tenant();
