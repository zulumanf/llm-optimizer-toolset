-- +migrate up
-- Spec 060: citation acquisition. The response_citations ledger (033) records
-- WHAT the engines cited; these tables record what we intend to DO about it.
-- One opportunity row per (project, domain) — mutable working state, unlike
-- the ledger it is derived from. Presence checks are append-only measured
-- facts. AI citation value is NOT backlink authority: no DA/DR columns exist
-- here on purpose — value comes only from observed citation behavior.

create table acquisition_providers (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  provider_type text not null check (provider_type in (
    'outreach_agency', 'citation_marketplace', 'pr_platform',
    'journalist_platform', 'directory_network', 'manual_outreach',
    'internal_team', 'partner_network')),
  placement_types text[] not null default '{}',
  cost_notes text,
  turnaround_notes text,
  restrictions text,
  quality_notes text,
  active boolean not null default true,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table citation_opportunities (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id),
  domain text not null,
  status text not null default 'discovered' check (status in (
    -- pipeline, in order
    'discovered', 'researched', 'qualified', 'prioritized', 'outreach_ready',
    'outreach_in_progress', 'negotiation', 'submitted', 'won', 'live',
    'verified', 'measuring',
    -- measured outcomes (only from measuring)
    'successful', 'inconclusive', 'no_observed_lift',
    -- terminal exits (from any non-terminal state)
    'rejected', 'not_eligible', 'not_worth_pursuing', 'spam_risk',
    'unable_to_contact', 'lost')),
  acquisition_path text not null default 'unknown' check (acquisition_path in (
    'editorial_pitch', 'guest_contribution', 'digital_pr', 'data_story',
    'expert_commentary', 'directory_listing', 'review_platform_profile',
    'industry_association', 'local_media', 'podcast_guest',
    'partnership_content', 'sponsored_placement', 'community_participation',
    'syndication', 'unknown')),
  acquisition_difficulty text not null default 'unknown'
    check (acquisition_difficulty in ('easy', 'moderate', 'hard', 'unknown')),
  estimated_cost_usd numeric check (estimated_cost_usd >= 0),
  estimated_days_to_live int check (estimated_days_to_live >= 0),
  contact_status text not null default 'none' check (contact_status in
    ('none', 'researching', 'found', 'contacted', 'responded')),
  eligibility_notes text,
  notes text,
  next_action text,
  provider_id uuid references acquisition_providers(id),
  -- ACVS snapshot: score + every component + the plain-language derivation,
  -- stamped with scorer and weight-set versions (docs/06 conventions)
  acvs numeric check (acvs between 0 and 100),
  acvs_components jsonb,
  acvs_explanation text[],
  acvs_version text,
  acvs_weight_set_version int,
  acvs_computed_at timestamptz,
  -- a placement IS an intervention (spec 007/051): verification, retests,
  -- verdicts, and the outcome spine attach here, never duplicated
  intervention_id uuid references interventions(id),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, domain)
);
create index citation_opportunities_project_status_idx
  on citation_opportunities (project_id, status);

-- Measured fact: did the client (or competitors) appear ON the source page
-- when we fetched it? Append-only — a later check is a new row, history kept.
create table source_presence_checks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id),
  domain text not null,
  url text not null,
  http_status int,
  ok boolean not null,
  client_present boolean,
  competitor_hits jsonb not null default '[]',
  error text,
  checked_by uuid references users(id),
  checked_at timestamptz not null default now()
);
create trigger source_presence_checks_immutable
  before update or delete on source_presence_checks
  for each row execute function forbid_mutation();
create index source_presence_checks_project_domain_idx
  on source_presence_checks (project_id, domain, checked_at desc);

-- ACVS weights, through the one configurable-weights mechanism (spec 039).
-- camelCase keys: db/client.ts reads jsonb through postgres.camel.
insert into scoring_weight_sets (name, version, weights, active, notes)
values (
  'citation-acvs', 1,
  '{"citationFrequency": 0.15, "promptRelevance": 0.10,
    "commercialIntent": 0.15, "crossEngine": 0.10,
    "recommendationInfluence": 0.15, "competitorDensity": 0.10,
    "clientGap": 0.10, "feasibility": 0.05,
    "sourceQuality": 0.05, "persistence": 0.05}'::jsonb,
  true,
  'Seeded default (spec 060, acvs-v1). Null components redistribute.'
);

-- +migrate down
delete from scoring_weight_sets where name = 'citation-acvs';
drop table source_presence_checks;
drop table citation_opportunities;
drop table acquisition_providers;
