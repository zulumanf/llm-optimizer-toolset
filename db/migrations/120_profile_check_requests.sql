-- +migrate up
-- Spec 147 (slice 1): the durable queue of profile checks.
--
-- One row per requested check of one client-confirmed profile URL. Rows are
-- released by a bounded dispatcher (lib/profile-corrections/dispatch.ts) that
-- publishes `profile.check_requested`; the event starts one run of
-- reputation_profile_correction_v1. Queueing instead of starting directly keeps
-- local inference (gpt-oss:20b extraction + qwen3:30b comparison) bounded on
-- one host, globally, across clients.
--
-- `kind = 'recheck'` rows belong to a later slice. Their
-- correction_request_id gains its foreign key when profile_correction_requests
-- is created; nothing in this slice writes a recheck row.
create table profile_check_requests (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id),
  kind text not null check (kind in ('check', 'recheck')),
  context_item_id uuid references engagement_context_items(id),
  correction_request_id uuid,
  profile_url text not null check (profile_url ~ '^https?://'),
  origin text not null check (origin in ('operator', 'schedule', 'recheck')),
  window_key text not null check (length(trim(window_key)) > 0),
  not_before timestamptz not null default now(),
  status text not null default 'queued'
    check (status in ('queued', 'released', 'skipped', 'failed')),
  reason text,
  -- Exactly the key the engine stores on workflow_runs.idempotency_key for the
  -- run this release starts, so capacity and abandonment can be judged by join.
  run_idempotency_key text not null unique,
  event_id uuid references domain_events(id),
  requested_by uuid references users(id),
  created_at timestamptz not null default now(),
  released_at timestamptz,
  constraint profile_check_requests_kind_ref check (
    (kind = 'check' and context_item_id is not null and correction_request_id is null) or
    (kind = 'recheck' and correction_request_id is not null)
  ),
  constraint profile_check_requests_released_has_time check (
    status <> 'released' or released_at is not null
  )
);

-- One check per confirmed profile per window (ISO week for the schedule, UTC
-- day for an operator), and one recheck per correction.
create unique index profile_check_requests_one_check
  on profile_check_requests (project_id, context_item_id, window_key)
  where kind = 'check';
create unique index profile_check_requests_one_recheck
  on profile_check_requests (correction_request_id)
  where kind = 'recheck';
-- The dispatcher's scan: oldest due queued work first.
create index profile_check_requests_due
  on profile_check_requests (status, not_before, created_at);
create index profile_check_requests_project
  on profile_check_requests (project_id, created_at desc);

-- Queue history is evidence of what was checked and why; it is never deleted.
create trigger profile_check_requests_no_delete
  before delete on profile_check_requests
  for each row execute function forbid_mutation();

-- +migrate down
drop trigger if exists profile_check_requests_no_delete on profile_check_requests;
drop table if exists profile_check_requests;
