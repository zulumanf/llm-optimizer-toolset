-- Spec 002: prompt sets, prompts, frozen immutable versions (docs/03, docs/07)

-- +migrate up
create table prompt_sets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id),
  name text not null,
  description text,
  created_at timestamptz not null default now(),
  archived_at timestamptz
);

create index prompt_sets_project_idx on prompt_sets (project_id);
create unique index prompt_sets_active_name_unique
  on prompt_sets (project_id, lower(name))
  where archived_at is null;

create table prompts (
  id uuid primary key default gen_random_uuid(),
  prompt_set_id uuid not null references prompt_sets(id),
  text text not null,
  category text not null check (
    category in ('recommendation', 'comparison', 'how-to', 'branded', 'problem')
  ),
  language text not null default 'en',
  position int not null,
  created_at timestamptz not null default now(),
  archived_at timestamptz
);

create index prompts_set_idx on prompts (prompt_set_id);

create table prompt_set_versions (
  id uuid primary key default gen_random_uuid(),
  prompt_set_id uuid not null references prompt_sets(id),
  version int not null,
  frozen_prompts jsonb not null,
  frozen_by uuid,
  frozen_at timestamptz not null default now(),
  unique (prompt_set_id, version)
);

create index prompt_set_versions_set_idx on prompt_set_versions (prompt_set_id);

-- Frozen versions are immutable forever (PRINCIPLES.md #3, docs/07 step 2).
-- Reuses forbid_mutation() from migration 001.
create trigger prompt_set_versions_immutable
  before update or delete on prompt_set_versions
  for each row execute function forbid_mutation();

-- +migrate down
drop trigger prompt_set_versions_immutable on prompt_set_versions;
drop table prompt_set_versions;
drop table prompts;
drop table prompt_sets;
