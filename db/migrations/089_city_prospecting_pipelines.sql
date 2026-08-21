-- +migrate up
-- Spec 097: the A→Z city prospecting pipeline as a durable state machine
-- the worker's tick advances. One row per kickoff; the log is an append-of
-- steps the operator can read back through the assistant.

create table city_prospecting_pipelines (
  id uuid primary key default gen_random_uuid(),
  city_name text not null,
  state_name text not null,
  status text not null default 'installing'
    check (status in ('installing','discovering','seeding','benchmarking','running','scoring','completed','failed')),
  -- target_prospects, budget_usd, segment — the confirmed parameters.
  params jsonb not null default '{}'::jsonb,
  launch_id uuid references market_launches(id),
  project_id uuid references projects(id),
  prompt_set_version_id uuid references prompt_set_versions(id),
  run_id uuid references runs(id),
  log jsonb not null default '[]'::jsonb,
  error text,
  requested_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index city_prospecting_pipelines_active_idx
  on city_prospecting_pipelines (status)
  where status not in ('completed','failed');

-- +migrate down
drop table city_prospecting_pipelines;
