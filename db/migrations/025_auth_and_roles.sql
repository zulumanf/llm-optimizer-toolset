-- Spec 014: real identity, real roles, and row-level security.
--
-- Until now `lib/auth.ts` returned a hardcoded dev user, so `audit_log.user_id`
-- pointed at a constant and every role gate compared against an env variable.
-- "Who did this" was only as trustworthy as a string in `.env`.
--
-- Design notes the column list does not carry:
--  * `users.id` IS the Supabase auth uid. No mapping table, no second identity
--    space to drift. A row here is the application's view of an account that
--    already exists in `auth.users`.
--  * Roles are DATA, not configuration. `DEV_USER_ROLE` stays for dev mode
--    only; in supabase mode the role comes from this table and can be changed
--    without a redeploy.
--  * `user_project_access` exists now although no client logins are issued
--    yet (spec 014's operator checklist defers them). It is the seam that
--    makes adding a read-only client account a data change rather than a
--    refactor of every list query.
--  * RLS is defence in depth, NOT the primary control. Service-layer scoping
--    stays. The app connects as the table owner (postgres) via DATABASE_URL,
--    and owners bypass RLS — so these policies bite only for connections made
--    with a non-owner role, which is exactly the Supabase-client path. Stated
--    plainly so nobody mistakes "RLS enabled" for "app queries are filtered".

-- +migrate up

create table users (
  -- Supabase auth uid. Not generated here: this table follows auth.users.
  id uuid primary key,
  email text not null unique,
  name text not null default '',
  role text not null default 'operator'
    check (role in ('admin', 'operator', 'reviewer', 'client_viewer', 'client_validator')),
  -- Deactivation without deletion: audit rows must keep resolving to a person.
  active boolean not null default true,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index users_active_idx on users (active) where active;

-- Which clients a non-staff account may see. Empty for staff roles, who see
-- everything; the helper below encodes that so no caller has to remember it.
create table user_project_access (
  user_id uuid not null references users(id) on delete cascade,
  project_id uuid not null references projects(id),
  -- Read-only is the only grant a client account can hold today. Writing is
  -- reserved for staff, and `client_validator` submits observations through a
  -- dedicated table rather than by writing to project data.
  access text not null default 'read' check (access in ('read')),
  granted_by uuid references users(id),
  granted_at timestamptz not null default now(),
  primary key (user_id, project_id)
);
create index user_project_access_project_idx on user_project_access (project_id);

-- Audit identity becomes real. Existing rows already point at actor ids, so
-- every referenced actor is backfilled as a user row FIRST and the FK is then
-- added fully validated. History stays readable rather than being rewritten or
-- dropped — losing "who did this" to gain a constraint would be a bad trade.
insert into users (id, email, name, role)
values ('00000000-0000-4000-8000-000000000001', 'dev@parva.local', 'Dev User', 'admin')
on conflict (id) do nothing;

-- Any other actor id already referenced by history (seeds, tests) gets a
-- placeholder row so the constraint can be validated without deleting audit.
insert into users (id, email, name, role, active)
select distinct a.user_id,
  'unknown+' || a.user_id || '@parva.local',
  'Unknown historical actor', 'operator', false
from audit_log a
where a.user_id is not null
  and not exists (select 1 from users u where u.id = a.user_id)
on conflict (id) do nothing;

alter table audit_log
  add constraint audit_log_user_fk foreign key (user_id) references users(id);

-- Evidence downloads are an access event, not just a read. docs/10 requires
-- knowing who took a copy of a client's raw material off the platform.
create table artifact_access_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id),
  artifact_type text not null
    check (artifact_type in ('evidence_artifact', 'evidence_export', 'source_artifact', 'report')),
  artifact_id uuid not null,
  project_id uuid references projects(id),
  action text not null default 'download' check (action in ('download', 'view')),
  ip_address text,
  user_agent text,
  accessed_at timestamptz not null default now()
);
create index artifact_access_log_artifact_idx
  on artifact_access_log (artifact_type, artifact_id, accessed_at desc);
create index artifact_access_log_user_idx on artifact_access_log (user_id, accessed_at desc);
-- An access record that can be edited is not an access record.
create trigger artifact_access_log_immutable
  before update or delete on artifact_access_log
  for each row execute function forbid_mutation();

-- --------------------------------------------------------------------- RLS
--
-- `auth.uid()` is provided by Supabase and does not exist in plain Postgres,
-- which local development and CI both run. Rather than making this migration
-- unrunnable outside Supabase — which would mean RLS could never be tested,
-- and docs/09 requires every migration to apply and reverse on CI — we install
-- a stub ONLY when the real function is absent.
--
-- The stub reads a session GUC, so a test can adopt an identity with
-- `set local app.current_user_id = '<uuid>'` and exercise the same policies
-- that will run against Supabase. On Supabase the real `auth.uid()` is found
-- and nothing here touches it; overwriting it would be catastrophic, so the
-- guard checks for the function, not merely the schema.
do $$
begin
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'auth' and p.proname = 'uid'
  ) then
    execute 'create schema if not exists auth';
    execute $fn$
      create function auth.uid() returns uuid as $body$
        select nullif(current_setting('app.current_user_id', true), '')::uuid
      $body$ language sql stable
    $fn$;
  end if;
end $$;

-- One helper, used by every policy, so the visibility rule is written once.
-- SECURITY DEFINER because a client_viewer must be able to ask "may I see this
-- project?" without being able to read the users table itself.
create or replace function current_app_user_role() returns text as $$
  select role from users where id = auth.uid() and active
$$ language sql stable security definer;

create or replace function can_read_project(target uuid) returns boolean as $$
  select case
    -- Staff see every client. This is an internal tool with one operator; the
    -- alternative (granting each project explicitly) would be ceremony that
    -- protects nobody and breaks silently when a project is created.
    when current_app_user_role() in ('admin', 'operator', 'reviewer') then true
    when current_app_user_role() is null then false
    else exists (
      select 1 from user_project_access a
      where a.user_id = auth.uid() and a.project_id = target
    )
  end
$$ language sql stable security definer;

alter table projects enable row level security;
alter table user_project_access enable row level security;
alter table users enable row level security;

create policy projects_read on projects
  for select using (can_read_project(id));
-- No insert/update/delete policy: writes never travel the Supabase client
-- path. They go through server actions on the owner connection, where the
-- service layer has already checked the role.

create policy users_read_self on users
  for select using (id = auth.uid() or current_app_user_role() = 'admin');

create policy access_read_self on user_project_access
  for select using (user_id = auth.uid() or current_app_user_role() = 'admin');

-- +migrate down
drop policy access_read_self on user_project_access;
drop policy users_read_self on users;
drop policy projects_read on projects;
alter table users disable row level security;
alter table user_project_access disable row level security;
alter table projects disable row level security;
drop function can_read_project(uuid);
drop function current_app_user_role();
-- Only remove the stub we installed; never drop Supabase's own auth.uid().
do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'auth' and p.proname = 'uid'
      and pg_get_functiondef(p.oid) like '%app.current_user_id%'
  ) then
    execute 'drop function auth.uid()';
  end if;
end $$;
drop trigger artifact_access_log_immutable on artifact_access_log;
drop table artifact_access_log;
alter table audit_log drop constraint audit_log_user_fk;
drop table user_project_access;
drop table users;
