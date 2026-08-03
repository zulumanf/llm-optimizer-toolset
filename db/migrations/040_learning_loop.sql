-- Spec 034: close the learning loop.
-- (1) Interventions state what they expect to happen. Nullable — historical
--     rows honestly have no hypothesis, and backfilling one would be fiction.
-- (2) `learnings`: durable, confidence-labeled knowledge distilled from
--     measured outcomes. Same confidence vocabulary as outcome_relationships
--     (spec 019) — one language for "how sure are we". Rows are retirable,
--     not editable: a changed statement is a new learning, so a learning a
--     decision cited stays readable as it was cited.

-- +migrate up
alter table interventions add column hypothesis text;

create table learnings (
  id uuid primary key default gen_random_uuid(),
  -- null = cross-project: a pattern observed across clients
  project_id uuid references projects(id),
  category text not null check (category in
    ('content', 'authority', 'entity', 'technical', 'distribution', 'process', 'other')),
  statement text not null check (char_length(statement) between 1 and 500),
  rationale text not null default '',
  confidence_label text not null check (confidence_label in
    ('confirmed', 'strongly_supported', 'correlated', 'probable', 'unknown')),
  source_action_outcome_ids uuid[] not null default '{}',
  evidence_note text,
  status text not null default 'active' check (status in ('active', 'retired')),
  retired_reason text,
  retired_by uuid references users(id),
  retired_at timestamptz,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  -- a retired learning must say why
  check (status = 'active' or retired_reason is not null)
);

create index learnings_project_idx on learnings (project_id);
create index learnings_status_category_idx on learnings (status, category);

-- +migrate down
drop table learnings;
alter table interventions drop column hypothesis;
