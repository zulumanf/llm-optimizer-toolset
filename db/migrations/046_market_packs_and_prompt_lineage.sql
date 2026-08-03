-- +migrate up
-- Spec 040: full geographic kind vocabulary, a cycle guard on the markets
-- tree, market-pack install provenance, and prompt generation lineage.

-- The markets tree becomes the one normalized hierarchy:
-- country → state → metro → city → borough/county → neighborhood (→ zip).
alter table markets drop constraint markets_kind_check;
alter table markets add constraint markets_kind_check check (kind in (
  'country', 'state', 'metro', 'city', 'borough', 'county', 'neighborhood',
  'zip', 'region', 'custom'
));

-- Exclusivity conflict detection walks parent chains recursively; a cycle
-- introduced by a bad edit would hang it (audit §10). Depth-capped walk.
create or replace function markets_no_cycle() returns trigger as $$
declare
  current uuid := new.parent_id;
  depth int := 0;
begin
  while current is not null loop
    if current = new.id then
      raise exception 'markets: cycle detected — % cannot be its own ancestor', new.id;
    end if;
    depth := depth + 1;
    if depth > 50 then
      raise exception 'markets: parent chain deeper than 50 — refusing';
    end if;
    select parent_id into current from markets where id = current;
  end loop;
  return new;
end;
$$ language plpgsql;

create trigger markets_no_cycle
  before insert or update of parent_id on markets
  for each row execute function markets_no_cycle();

-- Which pack version produced which subtree, with the exact definition used.
create table market_pack_installs (
  id uuid primary key default gen_random_uuid(),
  pack_key text not null,
  version int not null,
  root_market_id uuid not null references markets(id),
  definition jsonb not null,
  installed_by uuid references users(id),
  installed_at timestamptz not null default now(),
  unique (pack_key, version)
);

-- Generation lineage on prompts (nullable — manual prompts may not have it).
alter table prompts add column audience text;
alter table prompts add column price_tier text;
alter table prompts add column template_ref text;

-- +migrate down
alter table prompts drop column template_ref;
alter table prompts drop column price_tier;
alter table prompts drop column audience;
drop table market_pack_installs;
drop trigger markets_no_cycle on markets;
drop function markets_no_cycle();
alter table markets drop constraint markets_kind_check;
alter table markets add constraint markets_kind_check check (kind in (
  'city', 'borough', 'neighborhood', 'region', 'custom'
));
