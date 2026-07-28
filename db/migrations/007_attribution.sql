-- Spec 007: interventions, before/after windows, evidence, tasks (docs/03, docs/07)

-- +migrate up
create table interventions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id),
  title text not null,
  description text,
  shipped_at date not null,
  urls text[] not null default '{}',
  prompt_set_version_id uuid not null references prompt_set_versions(id),
  task_id uuid,
  baseline_weak boolean not null default false,
  created_by uuid,
  created_at timestamptz not null default now(),
  archived_at timestamptz
);

create index interventions_project_idx on interventions (project_id);
create index interventions_version_idx on interventions (prompt_set_version_id);

create table intervention_runs (
  id uuid primary key default gen_random_uuid(),
  intervention_id uuid not null references interventions(id),
  run_id uuid not null references runs(id),
  role text not null check (role in ('baseline', 'post')),
  offset_label text,
  unique (intervention_id, run_id)
);

create index intervention_runs_intervention_idx on intervention_runs (intervention_id);

-- Evidence: links claims (tasks, findings) to immutable proof (docs/03)
create table evidence (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('response', 'mention', 'score', 'source', 'report')),
  ref_id uuid not null,
  note text not null,
  created_by uuid,
  created_at timestamptz not null default now()
);

create table tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id),
  title text not null,
  description text,
  status text not null default 'suggested'
    check (status in ('suggested', 'approved', 'in_progress', 'done', 'rejected')),
  priority text not null default 'p2' check (priority in ('p1', 'p2', 'p3')),
  evidence_ids uuid[] not null,
  approved_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Software suggests only with proof (PRINCIPLES.md #8, docs/05)
  constraint tasks_suggested_need_evidence
    check (status != 'suggested' or cardinality(evidence_ids) >= 1)
);

create index tasks_project_idx on tasks (project_id, status);

-- +migrate down
drop table tasks;
drop table evidence;
drop table intervention_runs;
drop table interventions;
