-- +migrate up
-- Spec 041: provider-based prospect discovery. Adapter output lands as
-- CANDIDATES with a full provenance envelope; only human approval creates a
-- prospect (through the one createProspect path). Raw payloads are retained
-- so every later claim about a candidate stays auditable.

create table prospect_discovery_runs (
  id uuid primary key default gen_random_uuid(),
  launch_id uuid not null references market_launches(id),
  provider text not null,
  params jsonb not null default '{}',
  status text not null default 'queued' check (status in
    ('queued', 'running', 'completed', 'failed')),
  error text,
  candidate_count int,
  started_by uuid references users(id),
  started_at timestamptz not null default now(),
  completed_at timestamptz
);
create index prospect_discovery_runs_launch_idx
  on prospect_discovery_runs (launch_id);

create table prospect_discovery_candidates (
  id uuid primary key default gen_random_uuid(),
  discovery_run_id uuid not null references prospect_discovery_runs(id),
  launch_id uuid not null references market_launches(id),
  business_name text not null,
  -- The adapter's full RawProspect, verbatim.
  payload jsonb not null,
  -- The SourceRecord envelope.
  provider text not null,
  source_type text not null,
  source_url text,
  retrieved_at timestamptz not null,
  confidence numeric not null check (confidence >= 0 and confidence <= 1),
  provenance text not null check (provenance in
    ('verified', 'publicly_sourced', 'estimated', 'manual', 'ai_inferred')),
  status text not null default 'pending' check (status in
    ('pending', 'approved', 'dismissed', 'duplicate')),
  -- CompanyResolution computed at review time, kept for the audit trail.
  resolution jsonb,
  created_prospect_id uuid references prospects(id),
  reviewed_by uuid references users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
create index prospect_discovery_candidates_pending_idx
  on prospect_discovery_candidates (launch_id) where status = 'pending';
create index prospect_discovery_candidates_run_idx
  on prospect_discovery_candidates (discovery_run_id);

-- +migrate down
drop table prospect_discovery_candidates;
drop table prospect_discovery_runs;
