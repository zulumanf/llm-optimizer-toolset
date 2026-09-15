-- Evidence pipeline hardening (2026-09-14, competitor backfill incident).
--
-- 1. projects.market_id — canonical geography identity for MARKET-LEVEL
--    benchmark projects. Before this, lib/markets/bootstrap.ts keyed the
--    project on the display string "Market benchmark: <markets.name>", so
--    Wilmington, NC and Wilmington, DE shared one project and an NC attach
--    re-parsed DE answers. Identity is markets.id from now on; the name is a
--    label. Legacy projects are bound only where the name maps to exactly one
--    market AND exactly one project (unambiguous); anything else stays null
--    and is REVIEW_REQUIRED (scripts/pipeline-invariants.ts reports it).
--    Per-prospect benchmark projects (spec 032) never set market_id.
-- 2. response_parses.reconstructed_from_mentions — a ledger row re-derived
--    from the immutable mention revisions that already carry the classifier's
--    stamp, instead of re-classifying (the ledger was deleted by the old
--    delete-and-reparse backfill; the judgments were never lost).
-- 3. run_company_parses — per (run, company, alias graph hash) resolution
--    ledger: the identity of "company X has been resolved into run Y under
--    alias set Z". Backfill is idempotent and dependency-driven over it.
-- 4. company_backfills — one row per backfill execution: scope, reuse,
--    classifier calls, provider state, duration, result (observability +
--    cost guard).
-- Additive and idempotent. No existing row is deleted or rewritten except
-- the unambiguous market_id binding above.

-- +migrate up
alter table projects add column if not exists market_id uuid references markets(id);
create unique index if not exists projects_market_benchmark_uidx
  on projects (market_id) where market_id is not null and archived_at is null;

update projects p set market_id = m.id
from markets m
where p.market_id is null
  and p.archived_at is null
  and p.name = 'Market benchmark: ' || m.name
  and (select count(*) from markets m2 where m2.name = m.name) = 1
  and (select count(*) from projects p2 where p2.name = p.name and p2.archived_at is null) = 1;

alter table response_parses
  add column if not exists reconstructed_from_mentions boolean not null default false;

create table if not exists run_company_parses (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs(id),
  company_id uuid not null references companies(id),
  alias_hash text not null,
  parser_version text not null,
  scanned integer not null,
  hits integer not null,
  inserted integer not null,
  backfill_id uuid,
  created_at timestamptz not null default now(),
  unique (run_id, company_id, alias_hash)
);
create index if not exists run_company_parses_company_idx on run_company_parses (company_id);

create table if not exists company_backfills (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id),
  company_id uuid not null references companies(id),
  trigger text not null,
  status text not null check (status in
    ('queued', 'running', 'completed', 'provider_blocked', 'review_required', 'failed')),
  runs_considered integer,
  runs_touched integer,
  responses_considered integer,
  parses_reused integer,
  classifier_calls integer,
  mentions_inserted integer,
  provider_state text,
  duration_ms integer,
  detail text,
  requested_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists company_backfills_project_idx on company_backfills (project_id, company_id);

-- +migrate down
drop table if exists company_backfills;
drop table if exists run_company_parses;
alter table response_parses drop column if exists reconstructed_from_mentions;
drop index if exists projects_market_benchmark_uidx;
alter table projects drop column if exists market_id;
