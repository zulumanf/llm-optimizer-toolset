-- Dogfood: RecommendedFirst measured as an internal project. kind='internal'
-- runs the full client measurement pipeline while every client, portfolio and
-- prospect surface keeps excluding it (they filter kind='client' or read the
-- prospects table), so dogfood data can never blend into client metrics.

-- +migrate up
alter table projects drop constraint projects_kind_check;
alter table projects add constraint projects_kind_check
  check (kind in ('client', 'prospect', 'internal'));

-- +migrate down
-- Re-kind internal projects as prospect: keeps them off client surfaces
-- (the property that matters) without deleting measurement data.
update projects set kind = 'prospect' where kind = 'internal';
alter table projects drop constraint projects_kind_check;
alter table projects add constraint projects_kind_check
  check (kind in ('client', 'prospect'));
