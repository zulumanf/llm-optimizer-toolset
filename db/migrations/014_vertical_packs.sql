-- Spec 012: vertical packs — industries as versioned configuration, not forks

-- +migrate up
create table vertical_packs (
  id uuid primary key default gen_random_uuid(),
  key text not null,
  version int not null,
  name text not null,
  description text not null,
  -- Snapshot of the pack at pin time. Definitions live in TS
  -- (lib/verticals/packs.ts) as the reviewable source of truth; a project
  -- pins this row, so editing a pack later never mutates a live client
  -- (same philosophy as frozen prompt versions).
  definition jsonb not null,
  created_at timestamptz not null default now(),
  unique (key, version)
);

alter table projects add column vertical_pack_id uuid references vertical_packs(id);

-- +migrate down
alter table projects drop column vertical_pack_id;
drop table vertical_packs;
