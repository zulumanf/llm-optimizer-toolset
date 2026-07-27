-- Spec 003: runs, immutable raw responses, job queue, baseline config (docs/03)

-- +migrate up
create type run_status as enum ('pending', 'running', 'partial', 'completed', 'failed');

create table runs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id),
  prompt_set_version_id uuid not null references prompt_set_versions(id),
  label text not null,
  providers jsonb not null,
  status run_status not null default 'pending',
  status_detail text,
  trigger text not null check (trigger in ('manual', 'scheduled')),
  started_by uuid,
  budget_usd numeric not null,
  cost_usd numeric not null default 0,
  started_at timestamptz not null default now(),
  completed_at timestamptz
);

create index runs_project_idx on runs (project_id);
create index runs_started_idx on runs (started_at);

create table responses (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs(id),
  prompt_id uuid not null,
  prompt_text text not null,
  provider text not null,
  model text not null,
  repetition int not null,
  raw_payload jsonb,
  response_text text,
  refusal boolean not null default false,
  latency_ms int,
  tokens_in int,
  tokens_out int,
  cost_usd numeric not null default 0,
  error jsonb,
  requested_at timestamptz not null default now()
);

create index responses_run_idx on responses (run_id);
create index responses_provider_idx on responses (provider, model);
create index responses_requested_idx on responses (requested_at);

-- One successful capture per cell; failed attempts may accumulate (spec 003)
create unique index responses_cell_success_unique
  on responses (run_id, prompt_id, provider, model, repetition)
  where error is null;

-- Raw responses are insert-only forever (PRINCIPLES.md #3, docs/07 step 4).
-- Reuses forbid_mutation() from migration 001.
create trigger responses_immutable
  before update or delete on responses
  for each row execute function forbid_mutation();

create table jobs (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  payload jsonb not null,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'done', 'failed')),
  attempts int not null default 0,
  run_after timestamptz not null default now(),
  locked_by text,
  locked_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);

create index jobs_poll_idx on jobs (status, run_after);

-- Weekly-baseline configuration (cron); set via SQL/settings until a later spec
alter table projects add column baseline_prompt_set_id uuid references prompt_sets(id);
alter table projects add column baseline_config jsonb;

-- +migrate down
alter table projects drop column baseline_config;
alter table projects drop column baseline_prompt_set_id;
drop table jobs;
drop trigger responses_immutable on responses;
drop table responses;
drop table runs;
drop type run_status;
