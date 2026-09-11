-- +migrate up
-- Audit refresh queue (spec 075): after a scheduled benchmark run on a
-- prospect-kind project, the platform prepares one refresh candidate per
-- published audit fed by that project — new run linked, findings generated,
-- delta computed, preflight pre-run. A candidate is preparation, never
-- publication: only approveAuditRefresh (a staff click) publishes, through
-- the unchanged publishAudit gates.
--
-- status:
--   pending         — prepared and awaiting the operator's decision
--   needs_attention — preparation hit a problem (error says what); the
--                     full prospect page is the resolution path
--   approved        — the click happened; the audit republished
--   dismissed       — operator skipped it ("not this week")
--   superseded      — a newer run's candidate replaced it before any click
--
-- Candidates are preparation artifacts, not measurements: the immutable
-- evidence they point at lives in runs/scores/prospect_audits.snapshot.

create table audit_refresh_candidates (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid not null references prospects(id),
  run_id uuid not null references runs(id),
  finding_id uuid references prospect_findings(id),
  delta jsonb not null default '{}',
  preflight jsonb not null default '[]',
  status text not null default 'pending' check (status in
    ('pending', 'needs_attention', 'approved', 'dismissed', 'superseded')),
  error text,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references users(id)
);

create unique index audit_refresh_candidates_prospect_run_unique
  on audit_refresh_candidates (prospect_id, run_id);
create index audit_refresh_candidates_open_idx
  on audit_refresh_candidates (status)
  where status in ('pending', 'needs_attention');

-- +migrate down
drop index audit_refresh_candidates_open_idx;
drop index audit_refresh_candidates_prospect_run_unique;
drop table audit_refresh_candidates;
