-- +migrate up
-- Spec 124 data pass: the purchased RealTrends verified dataset as
-- first-class production evidence, keyed by its own rows and RESOLVED onto
-- the canonical companies layer — a comparison team no longer needs to be
-- an outreach prospect. Rows are the licensed workbook's facts (internal
-- use only; never rendered to prospects as raw data). Idempotent imports
-- dedupe on a deterministic fingerprint (the workbook carries no stable
-- RealTrends id).
create table realtrends_records (
  id uuid primary key default gen_random_uuid(),
  fingerprint text not null unique,
  dataset_name text not null,
  entity_type text not null check (entity_type in ('individual', 'team')),
  entity_name text not null,
  team_lead text,
  brokerage text,
  city text not null,
  state text not null,
  volume_usd numeric check (volume_usd is null or volume_usd >= 0),
  sides numeric check (sides is null or sides >= 0),
  production_year int not null,
  publication_year int,
  source_sheet text not null,
  source_row int not null,
  -- Canonical resolution (companies layer). Only high_confidence/confirmed
  -- rows may serve as verified evidence; confirmed = operator-resolved.
  company_id uuid references companies(id),
  match_status text not null default 'unmatched' check (match_status in
    ('unmatched', 'high_confidence', 'review_required', 'conflict', 'confirmed', 'rejected')),
  match_confidence numeric,
  match_detail jsonb,
  matched_at timestamptz,
  matched_by uuid references users(id),
  imported_at timestamptz not null default now(),
  created_by uuid references users(id)
);
create index realtrends_records_geo_idx on realtrends_records (state, city, entity_type);
create index realtrends_records_company_idx on realtrends_records (company_id)
  where company_id is not null;

-- +migrate down
drop table realtrends_records;
