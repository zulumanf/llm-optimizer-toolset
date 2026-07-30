-- Spec 025: keeping the knowledge layer honest over time.
--
-- Specs 020-024 build the layer; nothing in them notices when it rots. A
-- compiled page whose claim expired still serves. A source whose extraction
-- failed stays invisible. A dependency the compiler declared but never read
-- makes incremental rebuilds quietly wrong.
--
-- Design notes the column list does not carry:
--  * knowledge_exceptions deliberately mirrors workflow_exceptions rather than
--    inventing a second vocabulary. The Today feed already reads that shape,
--    so maintenance findings surface where the operator already looks instead
--    of in a new inbox nobody opens.
--  * knowledge_maintenance_runs is the idempotency key for the heartbeat. The
--    unique index on (kind, window_key) is what makes a per-minute cron safe:
--    a day's reconciliation happens once no matter how many callers race.
--  * retrieval_evaluations stores scored fixtures, not pass/fail. A regression
--    is a number moving, and you cannot see movement in a boolean.
--  * Legal hold is enforced in Postgres, not in code. A retention sweep is
--    exactly the kind of automated deletion that must not be able to remove
--    material under hold, so the trigger refuses rather than trusting a WHERE.

-- +migrate up

-- ------------------------------------------------------------- exceptions

create table knowledge_exceptions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id),
  -- What the maintenance run was doing when it found this.
  maintenance_run_id uuid,
  kind text not null check (kind in (
    'failed_ingestion', 'stale_page', 'expired_claim', 'broken_evidence_link',
    'orphaned_claim', 'dependency_mismatch', 'page_hash_mismatch',
    'failed_build', 'contradiction', 'duplicate_entity', 'weak_evidence',
    'low_quality_source', 'oversized_page', 'unused_page',
    'wiki_canonical_drift', 'stale_instruction', 'privacy_violation',
    'retrieval_regression', 'retention_due'
  )),
  severity text not null default 'medium'
    check (severity in ('low', 'medium', 'high', 'critical')),
  -- The object the exception is about, so the UI can deep-link without a join
  -- table: ('wiki_page', <uuid>), ('claim', <uuid>), ('source_artifact', …).
  subject_type text not null,
  subject_id uuid,
  summary text not null,
  detail jsonb not null default '{}'::jsonb,
  recommended_action text not null default '',
  status text not null default 'open'
    check (status in ('open', 'acknowledged', 'resolved', 'dismissed')),
  resolution text,
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

-- The re-raise guard. A daily job that re-reports the same stale page every
-- morning trains the operator to ignore the feed, so an open exception for a
-- given (kind, subject) exists at most once; the detector updates it instead.
create unique index knowledge_exceptions_open_unique
  on knowledge_exceptions (kind, subject_type, coalesce(subject_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where status in ('open', 'acknowledged');
create index knowledge_exceptions_feed_idx
  on knowledge_exceptions (project_id, severity, created_at desc)
  where status = 'open';

-- --------------------------------------------------------- maintenance runs

create table knowledge_maintenance_runs (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('daily', 'weekly')),
  -- The window's identity, not the caller's: '2026-07-30' / '2026-W31'.
  window_key text not null,
  project_id uuid references projects(id),
  status text not null default 'running'
    check (status in ('running', 'completed', 'partial', 'failed')),
  checks_run integer not null default 0,
  checks_failed integer not null default 0,
  exceptions_opened integer not null default 0,
  exceptions_resolved integer not null default 0,
  pages_rebuilt integer not null default 0,
  -- Proof the job reconciled rather than regenerated. A daily run that
  -- rebuilt everything would hide the staleness it exists to detect, so the
  -- ratio is recorded and asserted in tests.
  pages_considered integer not null default 0,
  detail jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  duration_ms integer
);

-- One run per window per scope. This is the whole idempotency guarantee for
-- the heartbeat: two dispatchers racing the same day produce one run.
create unique index knowledge_maintenance_runs_window
  on knowledge_maintenance_runs (kind, window_key,
    coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index knowledge_maintenance_runs_recent_idx
  on knowledge_maintenance_runs (kind, started_at desc);

alter table knowledge_exceptions
  add constraint knowledge_exceptions_run_fk
  foreign key (maintenance_run_id) references knowledge_maintenance_runs(id);

-- ---------------------------------------------------- retrieval evaluations

create table retrieval_evaluations (
  id uuid primary key default gen_random_uuid(),
  suite text not null,
  fixture_key text not null,
  task_type text not null,
  project_id uuid references projects(id),
  -- Scored, not pass/fail: a regression is a number moving.
  required_total integer not null default 0,
  required_found integer not null default 0,
  forbidden_total integer not null default 0,
  forbidden_present integer not null default 0,
  recall numeric(5,4),
  precision numeric(5,4),
  token_count integer not null default 0,
  token_budget integer,
  passed boolean not null default false,
  failures jsonb not null default '[]'::jsonb,
  packet_id uuid references evidence_packets(id),
  evaluated_at timestamptz not null default now()
);
create index retrieval_evaluations_suite_idx
  on retrieval_evaluations (suite, evaluated_at desc);
create unique index retrieval_evaluations_fixture_run
  on retrieval_evaluations (suite, fixture_key, evaluated_at);

-- ------------------------------------------------------ retention & holds

-- Retention needs three things the source table does not yet carry: when the
-- clock started, whether a human froze it, and whether the sweep has acted.
alter table source_artifacts
  add column legal_hold boolean not null default false,
  add column legal_hold_reason text,
  add column retention_due_at timestamptz,
  add column purged_at timestamptz;

create index source_artifacts_retention_idx
  on source_artifacts (retention_due_at)
  where purged_at is null and not legal_hold;

-- Enforced in the database, because the caller doing the deleting is an
-- unattended sweep. A WHERE clause that forgets the hold is a silent breach;
-- a trigger that refuses is a loud one.
create or replace function forbid_legal_hold_purge() returns trigger as $$
begin
  if old.legal_hold and (tg_op = 'DELETE' or new.purged_at is not null) then
    raise exception
      'source_artifact % is under legal hold and cannot be purged or deleted', old.id
      using hint = 'Clear legal_hold with a recorded reason first.';
  end if;
  return case tg_op when 'DELETE' then old else new end;
end;
$$ language plpgsql;

create trigger source_artifacts_legal_hold
  before update or delete on source_artifacts
  for each row execute function forbid_legal_hold_purge();

-- +migrate down
drop trigger source_artifacts_legal_hold on source_artifacts;
drop function forbid_legal_hold_purge();
drop index source_artifacts_retention_idx;
alter table source_artifacts
  drop column purged_at,
  drop column retention_due_at,
  drop column legal_hold_reason,
  drop column legal_hold;
drop table retrieval_evaluations;
alter table knowledge_exceptions drop constraint knowledge_exceptions_run_fk;
drop table knowledge_maintenance_runs;
drop table knowledge_exceptions;
