-- +migrate up
-- Spec 151 C4/C5 — business outcomes and delivery labor.
--
-- client_outcomes: what the CLIENT reports (or exports from its own system)
-- about leads, inquiry sources and closings, per period. Evidence class 1
-- (supplied business data), never mixed with benchmark observations, and
-- labelled by how it was obtained. Insert-only; a correction is a new row
-- that names the row it supersedes.
create table client_outcomes (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id),
  engagement_id uuid references client_engagements(id),
  period_start date not null,
  period_end date not null check (period_end >= period_start),
  provenance text not null check (provenance in ('self_reported', 'client_system_export')),
  qualified_leads int check (qualified_leads >= 0),
  leads_by_source jsonb not null default '{}',
  ai_discovery_mentions int check (ai_discovery_mentions >= 0),
  ai_referral_sessions int check (ai_referral_sessions >= 0),
  closed_transactions int check (closed_transactions >= 0),
  notes text,
  supersedes uuid references client_outcomes(id),
  recorded_by uuid references users(id),
  recorded_at timestamptz not null default now()
);
create index client_outcomes_project_idx on client_outcomes (project_id, period_start);
create trigger client_outcomes_immutable before update or delete on client_outcomes
  for each row execute function forbid_mutation();

-- labor_entries: human minutes spent delivering or selling, by activity.
-- The only way to know what delivery actually costs; insert-only, a
-- correction is a negative-minutes row that names the row it corrects.
create table labor_entries (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id),
  engagement_id uuid references client_engagements(id),
  activity text not null check (activity in (
    'onboarding', 'report_review', 'manual_intervention', 'support',
    'client_communication', 'optimization', 'measurement_review',
    'sales_prospecting', 'sales_call', 'operations', 'other')),
  minutes int not null check (minutes <> 0 and minutes between -1440 and 1440),
  occurred_on date not null,
  note text,
  corrects uuid references labor_entries(id),
  recorded_by uuid references users(id),
  recorded_at timestamptz not null default now(),
  check ((minutes > 0) or (corrects is not null))
);
create index labor_entries_project_idx on labor_entries (project_id, occurred_on);
create trigger labor_entries_immutable before update or delete on labor_entries
  for each row execute function forbid_mutation();

-- +migrate down
select rf_refuse_destructive_down(array['client_outcomes', 'labor_entries']);
drop table if exists labor_entries;
drop table if exists client_outcomes;
