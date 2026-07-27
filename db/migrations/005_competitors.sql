-- Spec 005: competitor tracking + unrecognized-brand discovery (docs/03)

-- +migrate up
create table competitors (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id),
  company_id uuid not null references companies(id),
  tier text not null check (tier in ('primary', 'secondary')),
  added_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (project_id, company_id)
);

create index competitors_project_idx on competitors (project_id);

-- Brands seen in answers that match no tracked alias. Humans promote them
-- (PRINCIPLES.md #8) — nothing is auto-tracked.
create table brand_candidates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  normalized text not null unique,
  hit_count int not null default 1,
  first_seen_run_id uuid references runs(id),
  last_seen_at timestamptz not null default now(),
  promoted_company_id uuid references companies(id),
  dismissed_at timestamptz
);

create index brand_candidates_hits_idx on brand_candidates (hit_count desc);

-- +migrate down
drop table brand_candidates;
drop table competitors;
