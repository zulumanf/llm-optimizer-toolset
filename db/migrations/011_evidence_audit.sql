-- Evidence Capture & Audit Trail (specs/llm-evidence-capture-and-audit-trail.md)

-- +migrate up

-- 1. Capture-time hashing, computed IN Postgres so capture, backfill, and
-- verification share one canonicalization (jsonb::text is canonical).
alter table responses
  add column response_hash text,
  add column payload_hash text,
  add column hashed_at timestamptz;

create or replace function compute_response_hashes() returns trigger as $$
begin
  new.response_hash := encode(sha256(convert_to(coalesce(new.response_text, ''), 'UTF8')), 'hex');
  new.payload_hash := case when new.raw_payload is null then null
    else encode(sha256(convert_to(new.raw_payload::text, 'UTF8')), 'hex') end;
  new.hashed_at := now();
  return new;
end;
$$ language plpgsql;

create trigger responses_hash before insert on responses
  for each row execute function compute_response_hashes();

-- Backfill integrity metadata for existing captures. The immutability
-- trigger is disabled ONLY for this statement; raw content is untouched
-- (hash columns are additive metadata) — recorded in DECISIONS.md.
alter table responses disable trigger responses_immutable;
update responses set
  response_hash = encode(sha256(convert_to(coalesce(response_text, ''), 'UTF8')), 'hex'),
  payload_hash = case when raw_payload is null then null
    else encode(sha256(convert_to(raw_payload::text, 'UTF8')), 'hex') end,
  hashed_at = now();
alter table responses enable trigger responses_immutable;

-- 2. Immutable evidence artifacts (screenshots, exports, future recordings)
create table evidence_artifacts (
  id uuid primary key default gen_random_uuid(),
  response_id uuid references responses(id),
  kind text not null check (kind in
    ('screenshot', 'raw_json', 'html_snapshot', 'video', 'export_file')),
  storage_key text not null unique,
  mime_type text not null,
  byte_size bigint not null,
  sha256 text not null,
  captured_at timestamptz not null default now(),
  capture_method text not null,
  note text,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index evidence_artifacts_response_idx on evidence_artifacts (response_id);
create trigger evidence_artifacts_immutable
  before update or delete on evidence_artifacts
  for each row execute function forbid_mutation();

-- 3. Seeded, reproducible audit samples
create table audit_samples (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs(id),
  seed integer not null,
  method text not null,
  requested_size integer not null,
  selected_response_ids uuid[] not null,
  constraints_met jsonb not null,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index audit_samples_run_idx on audit_samples (run_id);

-- 4. Holdout prompts: membership locks at freeze (frozen_prompts jsonb)
alter table prompts add column is_holdout boolean not null default false;

-- 5. Client validation — client-performed observations, stored strictly
-- apart from controlled benchmark data (never enter scores)
create table client_validation_runs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id),
  prompt_set_version_id uuid not null references prompt_set_versions(id),
  seed integer not null,
  selected_prompt_ids uuid[] not null,
  instructions text not null,
  status text not null default 'open' check (status in ('open', 'closed')),
  notes text,
  created_by uuid,
  created_at timestamptz not null default now()
);

create table client_validation_observations (
  id uuid primary key default gen_random_uuid(),
  validation_run_id uuid not null references client_validation_runs(id),
  prompt_id uuid not null,
  provider text not null,
  performed_on date not null,
  raw_response text not null,
  response_hash text,
  screenshot_artifact_id uuid references evidence_artifacts(id),
  claimed_mentioned boolean not null,
  claimed_recommended boolean not null,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index client_validation_obs_run_idx
  on client_validation_observations (validation_run_id);

create or replace function compute_validation_hash() returns trigger as $$
begin
  new.response_hash := encode(sha256(convert_to(new.raw_response, 'UTF8')), 'hex');
  return new;
end;
$$ language plpgsql;

create trigger client_validation_obs_hash before insert on client_validation_observations
  for each row execute function compute_validation_hash();

-- raw client submissions are evidence too: insert-only
create trigger client_validation_obs_immutable
  before update or delete on client_validation_observations
  for each row execute function forbid_mutation();

-- 6. Evidence export packages
create table evidence_exports (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs(id),
  status text not null default 'pending'
    check (status in ('pending', 'completed', 'failed')),
  storage_key text,
  sha256 text,
  manifest jsonb,
  requested_by uuid,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index evidence_exports_run_idx on evidence_exports (run_id);

-- +migrate down
drop table evidence_exports;
drop table client_validation_observations;
drop function compute_validation_hash();
drop table client_validation_runs;
alter table prompts drop column is_holdout;
drop table audit_samples;
drop table evidence_artifacts;
drop trigger responses_hash on responses;
drop function compute_response_hashes();
alter table responses drop column response_hash, drop column payload_hash,
  drop column hashed_at;
