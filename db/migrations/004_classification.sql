-- Spec 004: companies, mentions (revision model), scores, sources,
-- and the parse ledger (docs/03, docs/06)

-- +migrate up
create table companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  aliases text[] not null default '{}',
  domain text,
  is_self boolean not null default false,
  created_at timestamptz not null default now(),
  archived_at timestamptz
);

create unique index companies_active_name_unique
  on companies (lower(name)) where archived_at is null;
-- Exactly one Parva (spec 004 validation rules)
create unique index companies_one_self
  on companies (is_self) where is_self and archived_at is null;

create table mentions (
  id uuid primary key default gen_random_uuid(),
  response_id uuid not null references responses(id),
  company_id uuid not null references companies(id),
  revision int not null default 1,
  mentioned boolean not null,
  recommended boolean not null default false,
  list_position int,
  sentiment text not null default 'neutral'
    check (sentiment in ('positive', 'neutral', 'negative', 'mixed')),
  excerpt text,
  cited_urls text[] not null default '{}',
  parser_version text not null,
  confidence numeric not null,
  needs_review boolean not null default false,
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (response_id, company_id, revision)
);

create index mentions_response_idx on mentions (response_id);
create index mentions_company_idx on mentions (company_id);
create index mentions_review_idx on mentions (needs_review) where needs_review;

-- Corrections are new revisions; originals never change (docs/03)
create trigger mentions_immutable
  before update or delete on mentions
  for each row execute function forbid_mutation();

-- Parse ledger: responses are immutable, so parsed-state lives here.
-- One row per (response, parser_version); re-parses add rows.
create table response_parses (
  id uuid primary key default gen_random_uuid(),
  response_id uuid not null references responses(id),
  run_id uuid not null references runs(id),
  parser_version text not null,
  parsed_at timestamptz not null default now(),
  unique (response_id, parser_version)
);

create index response_parses_run_idx on response_parses (run_id);

create table scores (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs(id),
  company_id uuid not null references companies(id),
  metric text not null,
  provider text not null default 'all',
  value numeric not null,
  sample_size int not null,
  scoring_version text not null,
  computed_at timestamptz not null default now(),
  unique (run_id, company_id, metric, provider, scoring_version)
);

create index scores_run_idx on scores (run_id);

create table sources (
  id uuid primary key default gen_random_uuid(),
  url text not null unique,
  domain text not null,
  company_id uuid references companies(id),
  citation_count int not null default 0,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index sources_domain_idx on sources (domain);

-- +migrate down
drop table sources;
drop table scores;
drop table response_parses;
drop trigger mentions_immutable on mentions;
drop table mentions;
drop table companies;
