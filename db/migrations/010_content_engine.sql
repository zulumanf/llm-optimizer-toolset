-- Spec 010: content engine — assets flow brief→draft→verify→approve→publish;
-- versions are append-only history (docs/15)

-- +migrate up
create table content_assets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id),
  gap_finding_id uuid references gap_findings(id),
  asset_type text not null check (asset_type in (
    'service_page', 'comparison_page', 'faq', 'guide', 'case_study',
    'category_page', 'about_page'
  )),
  title text not null,
  target_prompt text,
  brief jsonb,
  status text not null default 'briefed'
    check (status in ('briefed', 'drafted', 'verified', 'approved', 'published')),
  published_url text,
  intervention_id uuid references interventions(id),
  created_by uuid,
  approved_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index content_assets_project_idx on content_assets (project_id, status);

-- Append-only body history: every draft/revision is a new version carrying
-- its verification report; nothing is ever edited in place
create table content_versions (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references content_assets(id),
  version int not null,
  body text not null,
  author text not null,          -- 'agent:<version>' or 'user:<id>'
  verification jsonb,            -- validator + fact-verifier report
  created_at timestamptz not null default now(),
  unique (asset_id, version)
);

create trigger content_versions_immutable
  before update or delete on content_versions
  for each row execute function forbid_mutation();

-- +migrate down
drop trigger content_versions_immutable on content_versions;
drop table content_versions;
drop table content_assets;
