-- Spec 027 — External source discovery.
--
-- Finding which pages on the open web carry facts about a client. Everything
-- downstream (ingest, extract, propose, approve) already exists; these two
-- tables record the step that did not.
--
-- `discovery_candidates` is insert-only on purpose. The record of what was
-- considered and *rejected* is the audit trail for corpus selection: a claim
-- set is only defensible if you can show what was looked at and why the rest
-- was dropped. A mutable candidate row would let that history be rewritten.

-- +migrate up
create table discovery_runs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects (id),
  status text not null default 'running'
    check (status in ('running', 'completed', 'partial', 'failed', 'safely_stopped')),
  -- The exact questions asked, so any claim traces back to the query that
  -- surfaced it. Templated and versioned — never agent-invented (docs/13).
  queries jsonb not null default '[]'::jsonb,
  template_key text not null,
  provider text not null,
  model text not null,
  candidates_found int not null default 0,
  candidates_ingested int not null default 0,
  candidates_skipped int not null default 0,
  claims_proposed int not null default 0,
  contradictions_raised int not null default 0,
  cost_micro_usd bigint not null default 0,
  cost_cap_micro_usd bigint,
  -- Why a run stopped short. Null on a clean completion.
  stop_reason text,
  error jsonb,
  started_by uuid references users (id),
  started_at timestamptz not null default now(),
  completed_at timestamptz
);

create index discovery_runs_project_idx on discovery_runs (project_id, started_at desc);

create table discovery_candidates (
  id uuid primary key default gen_random_uuid(),
  discovery_run_id uuid not null references discovery_runs (id),
  project_id uuid not null references projects (id),
  url text not null,
  normalized_url text not null,
  title text,
  -- The query that surfaced this URL, so a bad template is traceable.
  source_query text not null,
  decision text not null check (decision in ('ingested', 'skipped')),
  -- Always present for a skip. "Found nothing" and "found and could not fetch"
  -- must never render identically.
  skip_reason text,
  source_artifact_id uuid references source_artifacts (id),
  created_at timestamptz not null default now(),
  constraint discovery_candidate_decision_coherent check (
    (decision = 'ingested' and source_artifact_id is not null and skip_reason is null)
    or (decision = 'skipped' and skip_reason is not null)
  )
);

create index discovery_candidates_run_idx on discovery_candidates (discovery_run_id);
create index discovery_candidates_project_idx on discovery_candidates (project_id, normalized_url);

create trigger discovery_candidates_immutable
  before update or delete on discovery_candidates
  for each row execute function forbid_mutation();

-- +migrate down
drop trigger if exists discovery_candidates_immutable on discovery_candidates;
drop table if exists discovery_candidates;
drop table if exists discovery_runs;
