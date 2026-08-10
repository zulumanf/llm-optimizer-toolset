-- +migrate up
-- Spec 056: the companies registry learns what real estate needs.

-- Market scoping (audit §10 P1): the unique-name index was GLOBAL, so two
-- real "Smith Group"s in Miami and Austin were structurally
-- unrepresentable. One active name per market now, plus one in the global
-- (null-market) bucket; existing rows stay global.
alter table companies add column market_id uuid references markets(id);

drop index companies_active_name_unique;
create unique index companies_active_name_unique
  on companies (coalesce(market_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name))
  where archived_at is null;

-- Merge provenance (audit §10 P1): the registry carrying every mention,
-- score, and report had no merge operation at all. Merges are
-- non-destructive — the merged row archives with a pointer, its aliases
-- move to the survivor, and history stays where it was measured.
alter table companies add column merged_into uuid references companies(id);

-- +migrate down
alter table companies drop column merged_into;
drop index companies_active_name_unique;
-- Restoring the global index can collide if cross-market duplicates were
-- created; archive later duplicates rather than failing the rollback.
update companies c set archived_at = now()
  where c.archived_at is null
    and exists (
      select 1 from companies earlier
      where earlier.archived_at is null
        and lower(earlier.name) = lower(c.name)
        and earlier.created_at < c.created_at
    );
create unique index companies_active_name_unique
  on companies (lower(name)) where archived_at is null;
alter table companies drop column market_id;
