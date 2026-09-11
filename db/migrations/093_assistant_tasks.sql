-- +migrate up
-- Spec 115: delegated multi-step tasks the worker's tick advances. The
-- confirm click that creates one authorizes read/direct tools only,
-- within the stated step and cost budgets; confirm-tier actions still
-- stage for the operator (now linked by task_id) and park the task.
create table assistant_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  conversation_id uuid not null references assistant_conversations(id),
  goal text not null check (char_length(goal) <= 2000),
  status text not null default 'running'
    check (status in ('running','awaiting_confirmation','completed','failed','cancelled')),
  transcript jsonb not null default '[]'::jsonb,
  report text,
  steps_taken int not null default 0,
  max_steps int not null,
  cost_micro_usd bigint not null default 0,
  max_cost_micro_usd bigint not null,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index assistant_tasks_active_idx
  on assistant_tasks (status)
  where status in ('running','awaiting_confirmation');

alter table assistant_pending_actions
  add column task_id uuid references assistant_tasks(id);

-- +migrate down
alter table assistant_pending_actions drop column task_id;
drop table assistant_tasks;
