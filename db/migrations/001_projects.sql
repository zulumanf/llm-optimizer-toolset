-- Spec 001: projects + audit_log (docs/03-database-schema.md)

-- +migrate up
create extension if not exists pgcrypto;

create type project_status as enum ('active', 'archived');

create table projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  status project_status not null default 'active',
  created_at timestamptz not null default now(),
  archived_at timestamptz
);

-- Uniqueness among non-archived projects only, case-insensitive (spec 001 validation rules)
create unique index projects_active_name_unique
  on projects (lower(name))
  where status = 'active';

create table audit_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  action text not null,
  entity text not null,
  entity_id uuid,
  detail jsonb not null default '{}'::jsonb,
  at timestamptz not null default now()
);

create index audit_log_entity_idx on audit_log (entity, entity_id);
create index audit_log_at_idx on audit_log (at);

-- audit_log is insert-only (docs/03): trigger blocks UPDATE and DELETE
create function forbid_mutation() returns trigger
language plpgsql as $$
begin
  raise exception '% on % is forbidden: table is insert-only (PRINCIPLES.md #3)',
    tg_op, tg_table_name;
end;
$$;

create trigger audit_log_immutable
  before update or delete on audit_log
  for each row execute function forbid_mutation();

-- +migrate down
drop trigger audit_log_immutable on audit_log;
drop function forbid_mutation();
drop table audit_log;
drop table projects;
drop type project_status;
