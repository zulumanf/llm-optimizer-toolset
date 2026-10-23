-- +migrate up
-- Spec 151 B1 — one optimization plan over the existing finding engines.
--
-- An opportunity is a deduplicated, human-approvable unit of work derived
-- from a source finding (gap / citation opportunity / site finding /
-- accuracy finding). The source engines stay canonical; this table only
-- adds identity across runs (dedupe_key), lifecycle, approval requirements
-- and a measurement plan. Lifecycle is mutable; every transition is an
-- insert-only event.
create table opportunities (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id),
  dedupe_key text not null,
  source_kind text not null check (source_kind in
    ('gap_finding', 'citation_opportunity', 'site_finding', 'accuracy_finding')),
  source_id uuid not null,
  category text not null check (category in
    ('visibility_gap', 'citation_source', 'website', 'accuracy')),
  title text not null,
  observed_problem text not null,
  recommended_action text not null,
  target_intent text,
  target_location text,
  affected_url text,
  evidence jsonb not null default '[]',
  competitor_names text[] not null default '{}',
  priority_score numeric not null check (priority_score between 0 and 100),
  priority_band text not null check (priority_band in ('do_now', 'do_next', 'test', 'low_priority')),
  effort text not null default 'unknown' check (effort in ('low', 'medium', 'high', 'unknown')),
  estimated_cost_usd numeric check (estimated_cost_usd >= 0),
  confidence numeric check (confidence between 0 and 1),
  limitations text not null,
  approval_requirements text[] not null default '{}',
  measurement_plan jsonb not null default '{}',
  status text not null default 'proposed' check (status in
    ('proposed', 'approved', 'in_progress', 'implemented', 'measuring', 'closed', 'dismissed')),
  task_id uuid references tasks(id),
  intervention_id uuid references interventions(id),
  builder_version text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, dedupe_key)
);
create index opportunities_project_status_idx on opportunities (project_id, status);

create table opportunity_events (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid not null references opportunities(id),
  from_status text,
  to_status text not null,
  actor_id uuid references users(id),
  note text,
  at timestamptz not null default now()
);
create index opportunity_events_opp_idx on opportunity_events (opportunity_id, at);
create trigger opportunity_events_immutable before update or delete on opportunity_events
  for each row execute function forbid_mutation();

-- +migrate down
select rf_refuse_destructive_down(array['opportunities', 'opportunity_events']);
drop table if exists opportunity_events;
drop table if exists opportunities;
