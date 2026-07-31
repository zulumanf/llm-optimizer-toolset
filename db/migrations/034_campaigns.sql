-- +migrate up
-- Spec 029: campaigns — a grouping layer over existing execution objects.
-- "Become recommended for Manhattan luxury seller prompts" becomes an
-- object with a baseline captured at activation and target metrics,
-- instead of a memory. No new execution mechanics; verdict language and
-- causation rules stay specs/007's.

create table campaigns (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id),
  name text not null check (length(trim(name)) > 0),
  objective text not null check (length(trim(objective)) > 0),
  hypothesis text,
  status text not null default 'draft'
    check (status in ('draft', 'active', 'completed', 'abandoned')),
  starts_on date,
  ends_on date,
  owner_id uuid references users(id),
  -- captured at draft→active: subject metrics from the latest scored run,
  -- with scoring_version + run id + captured_at. Progress is computed on
  -- read against this snapshot and never stored.
  baseline jsonb,
  target_metrics jsonb not null default '[]',
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index campaigns_active_name_unique
  on campaigns (project_id, lower(name)) where status != 'abandoned';
create index campaigns_project_idx on campaigns (project_id);

create table campaign_members (
  campaign_id uuid not null references campaigns(id),
  kind text not null check (
    kind in ('prompt', 'gap_finding', 'task', 'intervention', 'content_asset')
  ),
  ref_id uuid not null,
  added_by uuid,
  added_at timestamptz not null default now(),
  primary key (campaign_id, kind, ref_id)
);

create index campaign_members_ref_idx on campaign_members (kind, ref_id);

-- +migrate down
drop table campaign_members;
drop table campaigns;
