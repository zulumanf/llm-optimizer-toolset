-- +migrate up
-- Spec 050: one ledger for every agent-path LLM call. Benchmark spend lives
-- on responses.cost_usd; agent spend (classification, content, accuracy,
-- gaps, workflows, assistant) was computed inside runAgent and thrown away —
-- the daily ceiling and every dashboard were blind to the platform's
-- highest-volume LLM traffic. Insert-only: it is a spend ledger, and a
-- ledger that can be edited is a receipt.
create table llm_calls (
  id uuid primary key default gen_random_uuid(),
  agent_version text not null,
  model text not null,
  -- Optional caller-supplied label ("parse_response", "accuracy_analysis")
  purpose text,
  -- Null = not attributable to one project; still counts in the global ceiling
  project_id uuid references projects(id),
  tokens_in int not null,
  tokens_out int not null,
  cost_micro_usd bigint not null,
  attempts int not null,
  -- False = the agent failed terminally; the spend still happened
  success boolean not null,
  called_at timestamptz not null default now()
);

create index llm_calls_called_at_idx on llm_calls (called_at);
create index llm_calls_project_idx on llm_calls (project_id);

-- Reuses forbid_mutation() from migration 001.
create trigger llm_calls_immutable
  before update or delete on llm_calls
  for each row execute function forbid_mutation();

-- +migrate down
drop table llm_calls;
