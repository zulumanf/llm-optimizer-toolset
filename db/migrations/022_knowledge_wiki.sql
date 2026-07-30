-- Specs 023 + 024: compiled knowledge, its provenance, and the build engine.
--
-- Design notes the column list does not carry:
--  * Compiled pages are ROWS, not files. A `.md` file on disk is editable by
--    anything with filesystem access, and an editable artifact that reads as
--    authoritative is precisely the failure this layer exists to prevent.
--    Rows get version identity, immutability triggers and provenance foreign
--    keys for free. Export to Markdown is a read, never the store.
--  * `wiki_page_versions` is immutable. The compiler is its only writer, and
--    the compiler reads canonical tables exclusively. There is therefore no
--    code path from editing a page to changing what the platform believes.
--  * Provenance lives in tables, not in YAML front matter inside the body.
--    Front matter would be unqueryable, hand-editable, and duplicated in every
--    rendering. The UI joins `wiki_section_provenance` directly.
--  * A hot file is a page with page_type = 'hot_file' and a token budget. Not
--    a parallel system: one compiler, one dependency graph, one build engine.

-- +migrate up

-- ------------------------------------------------------------------- pages

create table wiki_pages (
  id uuid primary key default gen_random_uuid(),
  -- Null = shared across clients (a market page, a methodology page)
  project_id uuid references projects(id),
  slug text not null,
  page_type text not null check (page_type in (
    'overview', 'identity', 'approved_claims', 'markets', 'neighborhoods',
    'specialties', 'transactions', 'competitors', 'reputation_findings',
    'visibility_performance', 'authority_strategy', 'attribution',
    'active_actions', 'current_priorities', 'open_risks', 'recent_changes',
    'market', 'methodology', 'hot_file'
  )),
  title text not null,
  -- Null = no explicit budget. Hot files always carry one.
  token_budget integer,
  active_version_id uuid,
  freshness_status text not null default 'unknown' check (freshness_status in
    ('current', 'nearing_review', 'stale', 'expired', 'superseded', 'unknown')),
  privacy_classification text not null default 'internal'
    check (privacy_classification in
      ('public', 'client_only', 'internal', 'restricted')),
  -- Marked by a canonical change; cleared by a successful compile.
  stale boolean not null default true,
  stale_since timestamptz default now(),
  stale_reason text not null default 'never compiled',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index wiki_pages_slug on wiki_pages (
  coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid), slug
);
create index wiki_pages_project_idx on wiki_pages (project_id, page_type);
create index wiki_pages_stale_idx on wiki_pages (stale) where stale;

create table wiki_page_versions (
  id uuid primary key default gen_random_uuid(),
  page_id uuid not null references wiki_pages(id),
  version integer not null,
  title text not null,
  summary text not null default '',
  body_markdown text not null,
  body_structured jsonb not null default '{}'::jsonb,
  -- sha256 of the rendered content. Identical output ⇒ no new active version,
  -- which is what keeps version history meaningful rather than churn.
  content_hash text not null,
  compiler_version text not null,
  template_version text not null,
  token_count integer not null default 0,
  freshness_status text not null default 'unknown',
  generated_at timestamptz not null default now(),
  effective_date date,
  build_id uuid,
  supersedes_version_id uuid references wiki_page_versions(id),
  created_at timestamptz not null default now()
);
create unique index wiki_page_versions_unique on wiki_page_versions (page_id, version);
create index wiki_page_versions_page_idx on wiki_page_versions (page_id, version desc);
create trigger wiki_page_versions_immutable
  before update or delete on wiki_page_versions
  for each row execute function forbid_mutation();

alter table wiki_pages
  add constraint wiki_pages_active_version_fk
  foreign key (active_version_id) references wiki_page_versions(id);

create table wiki_sections (
  id uuid primary key default gen_random_uuid(),
  page_version_id uuid not null references wiki_page_versions(id),
  section_key text not null,
  heading text not null,
  position smallint not null default 0,
  body_markdown text not null default '',
  token_count integer not null default 0,
  -- A material section states a client fact and must carry provenance.
  material boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index wiki_sections_unique on wiki_sections (page_version_id, section_key);
create trigger wiki_sections_immutable
  before update or delete on wiki_sections
  for each row execute function forbid_mutation();

create table wiki_section_provenance (
  id uuid primary key default gen_random_uuid(),
  section_id uuid not null references wiki_sections(id),
  claim_ids uuid[] not null default '{}',
  claim_version_ids uuid[] not null default '{}',
  evidence_ids uuid[] not null default '{}',
  instruction_version_ids uuid[] not null default '{}',
  source_artifact_ids uuid[] not null default '{}',
  compiled_at timestamptz not null default now(),
  compiler_version text not null
);
create unique index wiki_section_provenance_section on wiki_section_provenance (section_id);
create trigger wiki_section_provenance_immutable
  before update or delete on wiki_section_provenance
  for each row execute function forbid_mutation();

-- The stale-marking index. A canonical change resolves to a set of pages in
-- one set-based query rather than a per-page loop.
create table wiki_page_dependencies (
  id uuid primary key default gen_random_uuid(),
  page_id uuid not null references wiki_pages(id),
  dependency_type text not null check (dependency_type in (
    'entity', 'claim', 'claim_version', 'evidence', 'source_artifact',
    'transaction', 'prompt_cluster', 'visibility_measurement', 'action',
    'outcome', 'methodology', 'instruction', 'competitor', 'market',
    'neighborhood', 'page'
  )),
  dependency_id uuid not null,
  created_at timestamptz not null default now()
);
create unique index wiki_page_dependencies_unique
  on wiki_page_dependencies (page_id, dependency_type, dependency_id);
create index wiki_page_dependencies_lookup
  on wiki_page_dependencies (dependency_type, dependency_id);

-- ------------------------------------------------------------------ builds

create table knowledge_builds (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id),
  trigger text not null default 'manual'
    check (trigger in ('event', 'manual', 'maintenance', 'initial')),
  trigger_ref text,
  -- `partial` exists because a build with a failed page is not a completed
  -- build. An undisclosed partial result is the failure mode this codebase
  -- refuses everywhere else (see fanIn in lib/workflow/handlers.ts).
  status text not null default 'running'
    check (status in ('running', 'completed', 'partial', 'failed')),
  requested_pages integer not null default 0,
  compiled integer not null default 0,
  no_op integer not null default 0,
  failed integer not null default 0,
  duration_ms integer not null default 0,
  cost_micro_usd integer not null default 0,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  error text,
  created_by uuid
);
create index knowledge_builds_project_idx
  on knowledge_builds (project_id, started_at desc);

create table knowledge_build_items (
  id uuid primary key default gen_random_uuid(),
  build_id uuid not null references knowledge_builds(id),
  page_id uuid not null references wiki_pages(id),
  status text not null check (status in ('compiled', 'no_op', 'failed', 'skipped')),
  reason text not null default '',
  previous_version_id uuid references wiki_page_versions(id),
  new_version_id uuid references wiki_page_versions(id),
  content_hash text,
  token_count integer not null default 0,
  duration_ms integer not null default 0,
  error text,
  created_at timestamptz not null default now()
);
create unique index knowledge_build_items_unique on knowledge_build_items (build_id, page_id);
create index knowledge_build_items_build_idx on knowledge_build_items (build_id);
create trigger knowledge_build_items_immutable
  before update or delete on knowledge_build_items
  for each row execute function forbid_mutation();

create table knowledge_build_manifests (
  id uuid primary key default gen_random_uuid(),
  build_id uuid not null references knowledge_builds(id),
  manifest jsonb not null,
  manifest_hash text not null,
  created_at timestamptz not null default now()
);
create unique index knowledge_build_manifests_build on knowledge_build_manifests (build_id);
create trigger knowledge_build_manifests_immutable
  before update or delete on knowledge_build_manifests
  for each row execute function forbid_mutation();

alter table wiki_page_versions
  add constraint wiki_page_versions_build_fk
  foreign key (build_id) references knowledge_builds(id);

-- --------------------------------------------------------- human annotations

-- Explicitly labelled, owned, separate from generated content. An annotation
-- may be PROPOSED for canonicalization; it never overrides an approved claim,
-- and the compiler never merges it into a generated section.
create table wiki_annotations (
  id uuid primary key default gen_random_uuid(),
  page_id uuid not null references wiki_pages(id),
  section_key text,
  body text not null,
  author_id uuid,
  version integer not null default 1,
  status text not null default 'active'
    check (status in ('active', 'proposed_as_claim', 'promoted', 'retired')),
  promoted_claim_id uuid references claims(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index wiki_annotations_page_idx on wiki_annotations (page_id) where status <> 'retired';

-- +migrate down
drop table wiki_annotations;
alter table wiki_page_versions drop constraint wiki_page_versions_build_fk;
drop table knowledge_build_manifests;
drop table knowledge_build_items;
drop table knowledge_builds;
drop table wiki_page_dependencies;
drop table wiki_section_provenance;
drop table wiki_sections;
alter table wiki_pages drop constraint wiki_pages_active_version_fk;
drop table wiki_page_versions;
drop table wiki_pages;
