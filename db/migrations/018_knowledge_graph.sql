-- Spec 018 (Phase 2): the knowledge & evidence graph.
--
-- Extends spec 008's `claims` from "a verified fact" into a first-class graph
-- node: versioned, privacy-classified, wording-constrained, contradiction-
-- aware, and reachable only through a task-scoped evidence packet.
--
-- The rule this table structure enforces: an agent never receives the client's
-- whole knowledge base. It receives a packet built for one task, containing
-- approved claims only, with privacy filtering applied at retrieval time.

-- +migrate up

-- Claims become graph-shaped. All additive; existing rows keep working.
alter table claims
  add column normalized_predicate text,
  add column subject_entity text,
  add column object_entity_id uuid references companies(id),
  add column category text not null default 'general',
  add column effective_date date,
  add column review_date date,
  add column verification_status text not null default 'unverified'
    check (verification_status in
      ('unverified', 'verified', 'disputed', 'expired')),
  add column confidence numeric(4,3),
  -- Privacy is enforced at retrieval, not by convention (docs/10)
  add column privacy_status text not null default 'public'
    check (privacy_status in ('public', 'client_only', 'internal', 'restricted')),
  add column allowed_wording text[] not null default '{}',
  add column prohibited_wording text[] not null default '{}',
  add column version integer not null default 1;

create index claims_predicate_idx on claims (project_id, normalized_predicate);
create index claims_review_idx on claims (review_date) where review_date is not null;

-- Immutable history. A correction creates a new version; the old one stays
-- readable so a report generated last month remains reproducible.
create table claim_versions (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references claims(id),
  version integer not null,
  canonical_text text not null,
  value jsonb,
  normalized_predicate text,
  subject_entity text,
  object_entity_id uuid references companies(id),
  category text not null default 'general',
  status text not null,
  verification_status text not null,
  privacy_status text not null,
  allowed_wording text[] not null default '{}',
  prohibited_wording text[] not null default '{}',
  confidence numeric(4,3),
  as_of date,
  effective_date date,
  review_date date,
  evidence_ids uuid[] not null default '{}',
  change_reason text not null default '',
  created_by uuid,
  created_at timestamptz not null default now()
);
create unique index claim_versions_unique on claim_versions (claim_id, version);
create trigger claim_versions_immutable
  before update or delete on claim_versions
  for each row execute function forbid_mutation();

create table claim_contradictions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id),
  claim_id uuid not null references claims(id),
  -- Either another claim, or an external observation that disagrees
  contradicting_claim_id uuid references claims(id),
  external_source text,
  external_evidence_id uuid references evidence(id),
  severity text not null default 'medium'
    check (severity in ('low', 'medium', 'high', 'critical')),
  description text not null,
  detected_by text not null default 'deterministic',
  status text not null default 'open'
    check (status in ('open', 'resolved', 'dismissed')),
  resolution text,
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create index claim_contradictions_open_idx
  on claim_contradictions (project_id, severity) where status = 'open';
create index claim_contradictions_claim_idx on claim_contradictions (claim_id);

-- What an agent was actually shown, hashed. Reproducing a past agent decision
-- requires knowing its inputs — so the packet is evidence too.
create table evidence_packets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id),
  workflow_run_id uuid references workflow_runs(id),
  node_run_id uuid references node_runs(id),
  purpose text not null,
  claim_ids uuid[] not null default '{}',
  evidence_ids uuid[] not null default '{}',
  -- Claims withheld by privacy policy, recorded so the omission is auditable
  withheld_claim_ids uuid[] not null default '{}',
  contradictions jsonb not null default '[]'::jsonb,
  required_disclaimers text[] not null default '{}',
  methodology_version text,
  content jsonb not null,
  content_hash text not null,
  built_at timestamptz not null default now()
);
create index evidence_packets_project_idx on evidence_packets (project_id, built_at desc);
create trigger evidence_packets_immutable
  before update or delete on evidence_packets
  for each row execute function forbid_mutation();

-- +migrate down
drop table evidence_packets;
drop table claim_contradictions;
drop table claim_versions;
drop index claims_review_idx;
drop index claims_predicate_idx;
alter table claims
  drop column version,
  drop column prohibited_wording,
  drop column allowed_wording,
  drop column privacy_status,
  drop column confidence,
  drop column verification_status,
  drop column review_date,
  drop column effective_date,
  drop column category,
  drop column object_entity_id,
  drop column subject_entity,
  drop column normalized_predicate;
