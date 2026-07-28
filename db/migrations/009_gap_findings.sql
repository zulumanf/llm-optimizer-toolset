-- Spec 009: typed evidence-gap findings per scored run (docs/15)

-- +migrate up
create table gap_findings (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id),
  run_id uuid not null references runs(id),
  prompt_category text,
  gap_type text not null check (gap_type in (
    'entity', 'branded_recognition', 'recommendation', 'citation',
    'category_share', 'source_target'
  )),
  finding text not null,
  detail jsonb not null default '{}'::jsonb,
  severity numeric not null,
  opportunity_score numeric not null,
  detector_version text not null,
  status text not null default 'open'
    check (status in ('open', 'task_created', 'dismissed')),
  created_at timestamptz not null default now()
);

create index gap_findings_project_idx on gap_findings (project_id, status);
-- Re-analysis idempotency: NULL categories must collide too, and Postgres 14
-- treats NULLs as distinct in plain unique constraints — hence the coalesce
create unique index gap_findings_dedup
  on gap_findings (run_id, gap_type, coalesce(prompt_category, ''));

-- +migrate down
drop table gap_findings;
