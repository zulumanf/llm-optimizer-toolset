-- +migrate up
-- Spec 028: market exclusivity. The agency sells exclusive representation
-- within defined markets; until now that promise lived in nobody's memory
-- but the operator's. Geography is a containment tree (NYC → Manhattan →
-- Tribeca) so conflict detection can be structural — "Manhattan conflicts
-- with NYC because it is inside NYC", never string resemblance.

create table markets (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  kind text not null check (kind in ('city', 'borough', 'neighborhood', 'region', 'custom')),
  parent_id uuid references markets(id),
  aliases text[] not null default '{}',
  created_by uuid,
  created_at timestamptz not null default now()
);

-- Same name may exist under different parents (Chelsea/NYC vs Chelsea/
-- London), never twice under one parent. Roots dedupe against each other.
create unique index markets_name_per_parent_unique
  on markets (lower(name), coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index markets_parent_idx on markets (parent_id);

create table exclusivity_agreements (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id),
  status text not null default 'active' check (status in ('active', 'terminated')),
  starts_on date not null,
  ends_on date check (ends_on is null or ends_on >= starts_on),
  grace_period_days int not null default 0 check (grace_period_days >= 0),
  terminated_at date,
  notes text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index exclusivity_agreements_project_idx on exclusivity_agreements (project_id);

create table exclusivity_scopes (
  id uuid primary key default gen_random_uuid(),
  agreement_id uuid not null references exclusivity_agreements(id),
  market_id uuid not null references markets(id),
  -- null = "all services" / "all segments" — the widest protection
  service_category text,
  segment text,
  notes text
);

create unique index exclusivity_scopes_tuple_unique
  on exclusivity_scopes (agreement_id, market_id,
    coalesce(service_category, ''), coalesce(segment, ''));
create index exclusivity_scopes_market_idx on exclusivity_scopes (market_id);

-- Append-only: a conflict check is a record of a business decision made
-- with the information available at that moment. It is never edited.
create table exclusivity_checks (
  id uuid primary key default gen_random_uuid(),
  prospect_name text not null check (length(trim(prospect_name)) > 0),
  market_id uuid not null references markets(id),
  service_category text,
  segment text,
  result jsonb not null,
  worst_verdict text not null check (worst_verdict in ('direct', 'partial', 'possible', 'clear')),
  decision text not null check (decision in ('blocked', 'override', 'clear')),
  override_rationale text check (
    decision != 'override' or length(trim(coalesce(override_rationale, ''))) > 0
  ),
  checked_by uuid,
  checked_at timestamptz not null default now()
);

create trigger exclusivity_checks_immutable
  before update or delete on exclusivity_checks
  for each row execute function forbid_mutation();

create index exclusivity_checks_at_idx on exclusivity_checks (checked_at desc);

-- +migrate down
drop table exclusivity_checks;
drop table exclusivity_scopes;
drop table exclusivity_agreements;
drop table markets;
