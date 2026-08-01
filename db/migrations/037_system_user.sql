-- B3 (docs/pilot-launch-plan.md): background work runs as a real,
-- attributable principal. Worker handlers called getCurrentUser(), which
-- has no request context in a worker — under AUTH_MODE=supabase every such
-- job would throw, and under dev they silently acted as the dev admin.
-- Audit rows written by the platform itself now resolve to this user
-- instead of borrowing a person's identity.

-- +migrate up
insert into users (id, email, name, role, active)
values (
  '00000000-0000-4000-a000-000000000001',
  'system@parva.internal',
  'Parva Platform',
  'operator',
  true
)
on conflict (id) do nothing;

-- +migrate down
-- Reversible on a fresh database (CI's rollback path). On a live database
-- audit rows may already reference this user, in which case the FK makes
-- this delete fail loudly rather than orphaning history — deactivate the
-- row by hand if a rollback is ever genuinely needed there.
delete from users where id = '00000000-0000-4000-a000-000000000001';
