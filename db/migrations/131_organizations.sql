-- +migrate up
-- Spec 151 D1 — brokerage organizations (foundation only).
--
-- An organization groups measured entities (agents, teams, offices) it is
-- responsible for. Access is an explicit read-only grant per user; the
-- roster reads ONLY market-benchmark measurements (projects kind 'prospect'
-- bound to a market) — never another client's project — and never any
-- licensed RealTrends field.
create table organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  kind text not null default 'brokerage' check (kind in ('brokerage')),
  company_id uuid references companies(id),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  archived_at timestamptz
);

create table organization_entities (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  company_id uuid not null references companies(id),
  level text not null check (level in ('individual', 'team', 'office')),
  added_by uuid references users(id),
  added_at timestamptz not null default now(),
  removed_at timestamptz,
  unique (organization_id, company_id)
);
create index organization_entities_org_idx on organization_entities (organization_id) where removed_at is null;

create table organization_grants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  user_id uuid not null references users(id),
  granted_by uuid references users(id),
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (organization_id, user_id)
);

-- +migrate down
select rf_refuse_destructive_down(array['organizations', 'organization_entities', 'organization_grants']);
drop table if exists organization_grants;
drop table if exists organization_entities;
drop table if exists organizations;
