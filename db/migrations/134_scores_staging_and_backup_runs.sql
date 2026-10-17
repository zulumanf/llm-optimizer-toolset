-- +migrate up
-- Release 151 (final prep).
--
-- 1. scores_staging: v1.2 compatibility rows are written HERE until the
--    cutover, so `scores` holds exactly what pre-151 code would have written
--    (v1.1 only) and an application rollback to a pre-151 image stays safe —
--    its version-unfiltered readers never meet a second version. The cutover
--    copies staging → scores and flips scoring_state in one transaction.
--    Same shape and key as `scores`; insert-only.
create table scores_staging (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs(id),
  company_id uuid not null references companies(id),
  metric text not null,
  provider text not null,
  value numeric not null,
  sample_size int not null,
  scoring_version text not null,
  computed_at timestamptz not null default now(),
  unique (run_id, company_id, metric, provider, scoring_version)
);
create index scores_staging_run_idx on scores_staging (run_id);
create trigger scores_staging_immutable before update or delete on scores_staging
  for each row execute function forbid_mutation();

-- 2. backup_runs: one row per backup attempt, written by scripts/backup.sh
--    (BACKUP_RECORD=1) so the exception queue can alert on a stale backup.
--    Holds no secrets: artifact name, size, sha256, destination label.
create table backup_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null,
  finished_at timestamptz not null default now(),
  ok boolean not null,
  artifact text,
  size_bytes bigint,
  sha256 text,
  destination text,
  encrypted boolean not null,
  uploaded boolean not null,
  note text
);
create index backup_runs_finished_idx on backup_runs (finished_at desc);
create trigger backup_runs_immutable before update or delete on backup_runs
  for each row execute function forbid_mutation();

-- +migrate down
select rf_refuse_destructive_down(array['scores_staging', 'backup_runs']);
drop table if exists backup_runs;
drop table if exists scores_staging;
