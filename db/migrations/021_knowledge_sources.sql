-- Specs 020 + 021: the raw source layer and the canonical extensions it feeds.
--
-- Design notes the column list does not carry:
--  * `evidence_artifacts` (migration 011) is NOT reused for client source
--    material. It hangs off a `response_id` — an LLM capture — its `kind` check
--    enumerates capture kinds, and it has no project scope, effective date,
--    privacy class or version chain. Widening it would make one table mean two
--    things. The *byte-storage primitive* is shared in code instead.
--  * `source_artifacts` is content-immutable but status-mutable. A dedicated
--    trigger permits an update that touches only the status/supersession
--    columns and refuses anything that would rewrite content, hash or location.
--    The guard is in Postgres, not in application convention.
--  * `knowledge_entities.company_id` POINTS AT an existing companies row when
--    the entity is a tracked brand. Nothing is copied — there is one registry.
--  * `project_id` is the tenant key throughout (docs/15, CLAUDE.md: one team,
--    internal only). Nullable where a record is genuinely shared across clients
--    — a market, a methodology — so "Jersey City" is not duplicated per client.

-- +migrate up

-- ------------------------------------------------------------------ entities

create table knowledge_entities (
  id uuid primary key default gen_random_uuid(),
  -- Null = shared across clients (a market, a publication, a methodology)
  project_id uuid references projects(id),
  entity_type text not null check (entity_type in (
    'person', 'organization', 'brokerage', 'team', 'market', 'neighborhood',
    'specialty', 'publication', 'award', 'ranking', 'property', 'other'
  )),
  canonical_name text not null,
  slug text not null,
  -- Set when this entity IS a tracked company. Never a copy.
  company_id uuid references companies(id),
  description text not null default '',
  status text not null default 'active'
    check (status in ('active', 'merged', 'archived')),
  merged_into_id uuid references knowledge_entities(id),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index knowledge_entities_slug
  on knowledge_entities (
    coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid),
    entity_type, slug
  );
create index knowledge_entities_project_idx
  on knowledge_entities (project_id, entity_type) where status = 'active';
create index knowledge_entities_company_idx
  on knowledge_entities (company_id) where company_id is not null;

create table entity_aliases (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references knowledge_entities(id),
  alias text not null,
  normalized_alias text not null,
  -- Where the alias was observed, when it came from ingested material
  source_artifact_id uuid,
  confidence numeric(4,3) not null default 1.0,
  created_at timestamptz not null default now()
);
create unique index entity_aliases_unique
  on entity_aliases (entity_id, normalized_alias);
create index entity_aliases_lookup on entity_aliases (normalized_alias);

create table entity_relationships (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id),
  from_entity_id uuid not null references knowledge_entities(id),
  to_entity_id uuid not null references knowledge_entities(id),
  relationship_type text not null,
  effective_from date,
  effective_until date,
  evidence_ids uuid[] not null default '{}',
  confidence numeric(4,3),
  status text not null default 'proposed'
    check (status in ('proposed', 'approved', 'rejected', 'superseded')),
  created_by uuid,
  approved_by uuid,
  created_at timestamptz not null default now()
);
create index entity_relationships_from_idx
  on entity_relationships (from_entity_id, relationship_type) where status = 'approved';
create index entity_relationships_to_idx
  on entity_relationships (to_entity_id, relationship_type) where status = 'approved';

-- ------------------------------------------------------------ raw artifacts

-- Content is immutable; status moves forward. A statement that changes any
-- content column is refused by Postgres, so "never silently overwrite a raw
-- artifact" is a property of the database rather than a code review promise.
create function forbid_source_content_mutation() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'DELETE on % is forbidden: raw sources are evidence (PRINCIPLES.md #3)',
      tg_table_name;
  end if;
  if new.sha256 is distinct from old.sha256
     or new.storage_key is distinct from old.storage_key
     or new.byte_size is distinct from old.byte_size
     or new.mime_type is distinct from old.mime_type
     or new.project_id is distinct from old.project_id
     or new.source_type is distinct from old.source_type
     or new.original_url is distinct from old.original_url
     or new.original_filename is distinct from old.original_filename
     or new.version is distinct from old.version
     or new.created_at is distinct from old.created_at then
    raise exception
      'UPDATE on % may only advance status columns: raw source content is immutable (PRINCIPLES.md #3)',
      tg_table_name;
  end if;
  return new;
end;
$$;

create table source_artifacts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id),
  source_type text not null check (source_type in (
    'document', 'pdf', 'spreadsheet', 'website', 'crm_export',
    'analytics_export', 'search_console_export', 'transaction_file',
    'questionnaire', 'transcript', 'email', 'llm_response', 'screenshot',
    'ranking_record', 'published_content', 'api_response', 'image', 'other'
  )),
  origin text not null default 'upload' check (origin in (
    'upload', 'url_fetch', 'connector', 'webhook', 'manual', 'internal', 'import'
  )),
  original_filename text,
  original_url text,
  provider text,
  mime_type text not null,
  byte_size bigint not null,
  sha256 text not null,
  storage_key text not null,
  retrieved_at timestamptz not null default now(),
  -- When the content is true *about*, distinct from when we received it
  effective_date date,
  published_at date,
  -- One privacy vocabulary across sources, claims and packets
  privacy_classification text not null default 'client_only'
    check (privacy_classification in
      ('public', 'client_only', 'internal', 'restricted')),
  retention_class text not null default 'standard'
    check (retention_class in ('standard', 'short', 'legal_hold')),
  version integer not null default 1,
  supersedes_id uuid references source_artifacts(id),
  superseded_at timestamptz,
  extraction_status text not null default 'pending' check (extraction_status in
    ('pending', 'running', 'extracted', 'empty', 'failed', 'unsupported')),
  processing_status text not null default 'pending' check (processing_status in
    ('pending', 'normalized', 'claims_proposed', 'complete', 'failed')),
  created_by uuid,
  workflow_run_id uuid references workflow_runs(id),
  created_at timestamptz not null default now()
);
-- The idempotency guarantee for ingestion: identical bytes for one client are
-- one artifact, however many times an upload is retried or a sync re-runs.
create unique index source_artifacts_dedupe on source_artifacts (project_id, sha256);
create unique index source_artifacts_storage_key on source_artifacts (storage_key);
create index source_artifacts_project_idx
  on source_artifacts (project_id, created_at desc);
create index source_artifacts_url_idx on source_artifacts (project_id, original_url)
  where original_url is not null;
create index source_artifacts_pending_idx on source_artifacts (extraction_status)
  where extraction_status in ('pending', 'running');
create trigger source_artifacts_content_immutable
  before update or delete on source_artifacts
  for each row execute function forbid_source_content_mutation();

alter table entity_aliases
  add constraint entity_aliases_source_fk
  foreign key (source_artifact_id) references source_artifacts(id);

-- Extracted text lives apart from the original bytes, so re-extracting with a
-- new parser version never touches what the source actually said.
create table extracted_documents (
  id uuid primary key default gen_random_uuid(),
  source_artifact_id uuid not null references source_artifacts(id),
  extractor_key text not null,
  extractor_version text not null,
  text text not null default '',
  structured jsonb,
  -- Anchors an evidence excerpt to a location: page, sheet+row, csv row,
  -- json path, character offset. A claim cites where, not "the whole file".
  spans jsonb not null default '[]'::jsonb,
  token_count integer not null default 0,
  status text not null default 'extracted'
    check (status in ('extracted', 'empty', 'failed', 'unsupported')),
  error text,
  created_at timestamptz not null default now()
);
create unique index extracted_documents_version
  on extracted_documents (source_artifact_id, extractor_key, extractor_version);
create index extracted_documents_artifact_idx
  on extracted_documents (source_artifact_id, created_at desc);
create trigger extracted_documents_immutable
  before update or delete on extracted_documents
  for each row execute function forbid_mutation();

create table extraction_runs (
  id uuid primary key default gen_random_uuid(),
  source_artifact_id uuid not null references source_artifacts(id),
  extractor_key text not null,
  extractor_version text not null,
  status text not null check (status in ('succeeded', 'failed', 'skipped')),
  attempt smallint not null default 1,
  duration_ms integer not null default 0,
  error text,
  created_at timestamptz not null default now()
);
create index extraction_runs_artifact_idx
  on extraction_runs (source_artifact_id, created_at desc);
create trigger extraction_runs_immutable
  before update or delete on extraction_runs
  for each row execute function forbid_mutation();

-- Ambiguity is preserved, never resolved by discarding it (spec 021 Part 5).
create table source_normalizations (
  id uuid primary key default gen_random_uuid(),
  source_artifact_id uuid not null references source_artifacts(id),
  field text not null,
  original_value text not null,
  normalized_value text not null,
  normalized_entity_id uuid references knowledge_entities(id),
  match_confidence numeric(4,3),
  match_status text not null default 'unmatched'
    check (match_status in ('exact', 'probable', 'ambiguous', 'unmatched')),
  requires_review boolean not null default false,
  created_at timestamptz not null default now()
);
create index source_normalizations_artifact_idx
  on source_normalizations (source_artifact_id);
create index source_normalizations_review_idx
  on source_normalizations (requires_review) where requires_review;

-- -------------------------------------------------------------- instructions

-- The layer that separates "what is true" from "how it may be used". Without
-- it, brand voice and confidentiality rules can only live as per-claim string
-- arrays, which is why facts and rules currently arrive fused in one blob.
create table knowledge_instructions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id),
  instruction_type text not null check (instruction_type in (
    'evidence_policy', 'privacy_policy', 'attribution_policy',
    'content_quality', 'escalation_policy', 'workflow', 'agent',
    'brand_voice', 'approval_rule', 'confidentiality', 'prohibited_claim',
    'preferred_positioning', 'tone', 'connector_usage'
  )),
  scope text not null default 'project'
    check (scope in ('global', 'project', 'workflow', 'agent')),
  -- Workflow key or agent key when scope demands one; null otherwise
  scope_ref text,
  title text not null,
  active_version_id uuid,
  owner text not null default '',
  status text not null default 'active'
    check (status in ('active', 'retired')),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index knowledge_instructions_scope_idx
  on knowledge_instructions (scope, scope_ref) where status = 'active';
create index knowledge_instructions_project_idx
  on knowledge_instructions (project_id, instruction_type) where status = 'active';

create table knowledge_instruction_versions (
  id uuid primary key default gen_random_uuid(),
  instruction_id uuid not null references knowledge_instructions(id),
  version integer not null,
  body text not null,
  priority smallint not null default 100,
  effective_from date not null default current_date,
  effective_until date,
  requires_approval boolean not null default false,
  approved_by uuid,
  approved_at timestamptz,
  change_reason text not null default '',
  created_by uuid,
  created_at timestamptz not null default now()
);
create unique index knowledge_instruction_versions_unique
  on knowledge_instruction_versions (instruction_id, version);
create trigger knowledge_instruction_versions_immutable
  before update or delete on knowledge_instruction_versions
  for each row execute function forbid_mutation();

alter table knowledge_instructions
  add constraint knowledge_instructions_active_version_fk
  foreign key (active_version_id) references knowledge_instruction_versions(id);

-- ----------------------------------------------------- claim ← source links

-- A claim proposed from ingested material must name the artifact and the span
-- it came from, or the excerpt is unverifiable.
alter table claims
  add column source_artifact_ids uuid[] not null default '{}',
  add column materiality text not null default 'ordinary'
    check (materiality in ('ordinary', 'material', 'high_risk')),
  add column subject_entity_id uuid references knowledge_entities(id),
  add column last_verified_at timestamptz;

create index claims_subject_entity_idx on claims (subject_entity_id)
  where subject_entity_id is not null;

-- +migrate down
drop index claims_subject_entity_idx;
alter table claims
  drop column last_verified_at,
  drop column subject_entity_id,
  drop column materiality,
  drop column source_artifact_ids;
alter table knowledge_instructions drop constraint knowledge_instructions_active_version_fk;
drop table knowledge_instruction_versions;
drop table knowledge_instructions;
drop table source_normalizations;
drop table extraction_runs;
drop table extracted_documents;
alter table entity_aliases drop constraint entity_aliases_source_fk;
drop table source_artifacts;
drop function forbid_source_content_mutation();
drop table entity_relationships;
drop table entity_aliases;
drop table knowledge_entities;
