-- Spec 141 (citation readiness): the placement-level citation map behind
-- citation_opportunities (which is one row per project × domain), plus the
-- three intervention fields the remeasurement protocol needs (control
-- entity, changed URL, change description). Held-out prompts already exist
-- (frozen_prompts[].isHoldout); baseline/post results are intervention_runs.
-- Additive only: no existing row is read, rewritten or deleted. Idempotent
-- (if not exists) so a partial apply can be re-run; down drops only what up
-- created.

-- +migrate up
create table if not exists citation_map_targets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id),
  opportunity_id uuid references citation_opportunities(id),
  target_phrase text not null,
  market text not null,
  provider text not null,
  model_label text not null,
  prompt_id uuid references prompts(id),
  cited_url text not null,
  cited_domain text not null,
  source_class text not null check (source_class in ('client_site', 'brokerage', 'portal', 'news', 'directory', 'social', 'video', 'review', 'government', 'industry_ranking', 'local_press', 'other')),
  citation_frequency int not null default 0 check (citation_frequency >= 0),
  competitor_presence int not null default 0 check (competitor_presence >= 0),
  page_type text not null default 'other' check (page_type in ('listicle', 'guide', 'news_article', 'directory_listing', 'profile', 'forum_thread', 'ranking', 'other')),
  publication_date date,
  last_checked_at timestamptz,
  relevance_score numeric check (relevance_score between 0 and 1),
  insertability_score numeric check (insertability_score between 0 and 1),
  priority_score numeric check (priority_score between 0 and 100),
  priority_components jsonb,
  priority_version text,
  author_or_editor text,
  contact_url text,
  status text not null default 'discovered' check (status in ('discovered', 'qualified', 'contact_identified', 'pitched', 'approved', 'live', 'indexed', 'remeasured', 'declined', 'dropped')),
  proposed_contribution text,
  live_placement_url text,
  recheck_on date,
  baseline_run_id uuid references runs(id),
  remeasure_run_id uuid references runs(id),
  citation_change_after_placement jsonb,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, cited_url, provider)
);
create index if not exists citation_map_targets_project_status_idx on citation_map_targets (project_id, status);
create index if not exists citation_map_targets_recheck_idx on citation_map_targets (recheck_on) where recheck_on is not null;

alter table interventions
  add column if not exists control_company_id uuid references companies(id),
  add column if not exists changed_url text,
  add column if not exists change_description text;

-- +migrate down
alter table interventions
  drop column if exists change_description,
  drop column if exists changed_url,
  drop column if exists control_company_id;
drop table if exists citation_map_targets;
