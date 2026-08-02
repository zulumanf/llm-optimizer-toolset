-- +migrate up
-- Spec 032 Phase 2.1: prospect-owned benchmark runs. A prospect benchmark
-- project is a full `projects` row (the entire measurement pipeline keys on
-- project_id) marked kind='prospect' so that:
--   1. client-facing and portfolio surfaces can exclude it, and
--   2. company scoping can keep treating its subject as an ordinary market
--      entity — only CLIENT subjects are excluded from other projects'
--      measured sets (spec 008 no-cross-talk is a promise between clients,
--      not between a client and a market team we merely benchmark).

alter table projects add column kind text not null default 'client'
  check (kind in ('client', 'prospect'));

create index projects_kind_active_idx on projects (kind) where status = 'active';

-- The prospect record remembers its dedicated benchmark project, if one
-- was created (prospects linked to existing client-run data have none).
alter table prospects add column benchmark_project_id uuid references projects(id);

create index prospects_benchmark_project_idx
  on prospects (benchmark_project_id) where benchmark_project_id is not null;

-- +migrate down
drop index prospects_benchmark_project_idx;
alter table prospects drop column benchmark_project_id;
drop index projects_kind_active_idx;
alter table projects drop column kind;
