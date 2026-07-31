-- +migrate up
-- Phase 1.4 (docs/implementation-roadmap.md): the 2026-07-31 audit found tasks
-- are an evidence-and-approval ledger with no owners, due dates, or comments —
-- nobody is accountable for a task and nothing says when it is late.
--
-- `client_visible` defaults false on purpose: nothing becomes client-facing
-- implicitly. The future client portal filters on this column, so the safety
-- property is that exposure is always an explicit operator decision.

alter table tasks add column owner_id uuid references users(id);
alter table tasks add column due_date date;
alter table tasks add column client_visible boolean not null default false;

create index tasks_owner_idx on tasks (owner_id);
create index tasks_due_date_idx on tasks (due_date) where due_date is not null;

create table task_comments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references tasks(id),
  author_id uuid not null references users(id),
  body text not null check (length(trim(body)) > 0),
  created_at timestamptz not null default now()
);
create index task_comments_task_idx on task_comments (task_id);

-- A discussion record you can edit after the fact is not a record.
-- Reuses forbid_mutation() from migration 001.
create trigger task_comments_immutable
  before update or delete on task_comments
  for each row execute function forbid_mutation();

-- +migrate down
drop trigger task_comments_immutable on task_comments;
drop table task_comments;
drop index tasks_due_date_idx;
drop index tasks_owner_idx;
alter table tasks drop column client_visible;
alter table tasks drop column due_date;
alter table tasks drop column owner_id;
