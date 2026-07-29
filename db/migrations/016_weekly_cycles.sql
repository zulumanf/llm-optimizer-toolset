-- Spec 017: the automated weekly operating cycle, one row per client-week.

-- +migrate up
create table cycle_runs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id),
  -- Monday of the ISO week this cycle covers
  week_start date not null,
  state text not null default 'started' check (state in (
    'started', 'running_benchmark', 'analyzing', 'drafting',
    'completed', 'halted', 'failed'
  )),
  -- Why automation stopped and handed back to a human (spec 017 contract)
  halt_reason text,
  run_id uuid references runs(id),
  report_id uuid references reports(id),
  steps jsonb not null default '[]'::jsonb,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);

-- One cycle per client-week: a repeated cron call is a no-op
create unique index cycle_runs_one_per_week
  on cycle_runs (project_id, week_start);
create index cycle_runs_state_idx on cycle_runs (state);

-- +migrate down
drop table cycle_runs;
