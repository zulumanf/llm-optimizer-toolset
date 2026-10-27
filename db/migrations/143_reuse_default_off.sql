-- Spec 161: capture reuse is decided at run creation (client projects never
-- reuse; prospect benchmarks default to reuse). The column default no longer
-- opts a run in silently.

-- +migrate up
alter table runs alter column reuse_captures set default false;

-- +migrate down
alter table runs alter column reuse_captures set default true;
