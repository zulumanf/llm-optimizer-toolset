-- Spec 008: project = client engagement — per-project subject + verified claims

-- +migrate up
alter table projects add column subject_company_id uuid references companies(id);

-- Backfill: the legacy global is_self company becomes every project's subject
update projects set subject_company_id =
  (select id from companies where is_self and archived_at is null limit 1);

-- is_self stays as a deprecated fallback for one release (docs/15); the
-- one-self uniqueness rule no longer applies in a multi-client world
drop index companies_one_self;

-- External URLs join the evidence kinds (claims cite the web)
alter table evidence drop constraint evidence_kind_check;
alter table evidence add constraint evidence_kind_check
  check (kind in ('response', 'mention', 'score', 'source', 'report', 'url'));
alter table evidence add column url text;

create table claims (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id),
  key text not null,
  canonical_text text not null,
  value jsonb,
  as_of date,
  status text not null default 'proposed'
    check (status in ('proposed', 'approved', 'rejected', 'superseded')),
  evidence_ids uuid[] not null default '{}',
  created_by uuid,
  approved_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index claims_project_idx on claims (project_id, status);
-- One approved claim per fact key per project
create unique index claims_one_approved_per_key
  on claims (project_id, key) where status = 'approved';

-- +migrate down
drop table claims;
-- URL evidence rows exist only because this migration allowed them; they
-- cannot survive the narrowed CHECK (cleanup audit 2026-08-18 — a narrowing
-- down must clean the rows its up enabled, or rollback fails on real data).
delete from evidence where kind = 'url';
alter table evidence drop column url;
alter table evidence drop constraint evidence_kind_check;
alter table evidence add constraint evidence_kind_check
  check (kind in ('response', 'mention', 'score', 'source', 'report'));
create unique index companies_one_self
  on companies (is_self) where is_self and archived_at is null;
alter table projects drop column subject_company_id;
