-- Spec 132: multi-client delivery QA. Material QA outcomes for a retained
-- engagement (failure, review required, override, resolution) are recorded
-- as events — never the millions of PASS results. One open event per
-- (engagement, lane, code); a scan that no longer sees the condition resolves
-- it; a founder override records actor, time, reason and the previous result.
-- Portfolio scans log one row per run so the daily cadence is checkable.

-- +migrate up
create table engagement_qa_events (
  id uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references client_engagements(id),
  project_id uuid not null references projects(id),
  lane text not null check (lane in (
    'activation', 'evidence', 'execution', 'measurement', 'communication',
    'portfolio', 'security', 'offboarding')),
  code text not null check (length(trim(code)) > 0),
  severity text not null check (severity in ('P0', 'P1', 'P2')),
  status text not null default 'open' check (status in ('open', 'resolved', 'overridden')),
  message text not null default '',
  detail jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz,
  override_by uuid references users(id),
  override_at timestamptz,
  override_reason text,
  previous_result jsonb,
  constraint engagement_qa_events_override_has_reason check (
    status != 'overridden' or (override_by is not null and override_at is not null
      and length(trim(coalesce(override_reason, ''))) > 0)
  ),
  constraint engagement_qa_events_resolved_has_time check (
    status != 'resolved' or resolved_at is not null
  )
);
create unique index engagement_qa_events_open_unique
  on engagement_qa_events (engagement_id, lane, code) where status = 'open';
create index engagement_qa_events_project_idx on engagement_qa_events (project_id, status);
create index engagement_qa_events_severity_idx on engagement_qa_events (severity) where status = 'open';

create table portfolio_qa_scans (
  id uuid primary key default gen_random_uuid(),
  ran_at timestamptz not null default now(),
  engagements int not null,
  alerts int not null,
  p0 int not null default 0,
  p1 int not null default 0,
  duration_ms int not null default 0,
  detail jsonb not null default '{}'::jsonb
);
create index portfolio_qa_scans_ran_idx on portfolio_qa_scans (ran_at desc);

-- +migrate down
drop table portfolio_qa_scans;
drop table engagement_qa_events;
