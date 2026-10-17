-- +migrate up
-- Spec 151 milestone A — measurement v2.
--
-- 1. Instrument provenance on captures. `served_model` is what the provider
--    says it actually ran (payload.model / modelVersion), extracted at
--    capture; NULL on historical rows, which resolve on read through the same
--    pure extractor (lib/ai/served-model.ts). `captured_at` is when the
--    answer was produced: a reused capture (spec 054) copies its source's
--    time instead of claiming "now". NULL means requested_at. Columns are
--    added, never backfilled — responses stays insert-only.
alter table responses
  add column served_model text,
  add column captured_at timestamptz;

-- Mention rows record the deterministic matching layer they were written
-- with (lib/constants.ts ENTITY_MATCHER_VERSION). NULL = before spec 151.
alter table mentions add column matcher_version text;

-- 2. Pinned measurement instruments: one versioned config per project. The
--    market bootstrap pins a named default instead of copying whatever run
--    finished last anywhere in the system. Insert-only; a change is a new
--    version.
create table measurement_instruments (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id),
  version int not null check (version >= 1),
  providers jsonb not null check (jsonb_typeof(providers) = 'array' and jsonb_array_length(providers) > 0),
  location_context text not null default 'prompt_text_only',
  reason text not null,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (project_id, version)
);
create trigger measurement_instruments_immutable
  before update or delete on measurement_instruments
  for each row execute function forbid_mutation();

-- 3. Frozen competitor cohorts: the share-of-voice universe for a project,
--    frozen at baseline and versioned. Prospect discovery growing the global
--    registry can no longer move a client's denominator.
create table competitor_cohorts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id),
  version int not null check (version >= 1),
  subject_company_id uuid references companies(id),
  company_ids uuid[] not null check (cardinality(company_ids) >= 1),
  reason text not null,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (project_id, version)
);
create trigger competitor_cohorts_immutable
  before update or delete on competitor_cohorts
  for each row execute function forbid_mutation();

-- 4. Per-instrument estimates with statistical intervals (scoring v1.2+).
--    Never blended: one row per (run, company, metric, instrument). Wilson is
--    the naive independent-answer interval; clustered is the prompt-level
--    bootstrap (NULL below the cluster minimum). These are STATISTICAL
--    intervals — classifier confidence lives on mentions and is never here.
create table score_estimates (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs(id),
  company_id uuid not null references companies(id),
  metric text not null,
  provider text not null,
  model text not null,
  instrument_key text not null,
  served_models text[] not null default '{}',
  numerator int not null check (numerator >= 0),
  denominator int not null check (denominator >= numerator),
  distinct_prompts int not null check (distinct_prompts >= 0),
  excluded_echo int not null default 0 check (excluded_echo >= 0),
  rate numeric,
  wilson_low numeric,
  wilson_high numeric,
  clustered_low numeric,
  clustered_high numeric,
  icc numeric,
  cohort_id uuid references competitor_cohorts(id),
  scoring_version text not null,
  computed_at timestamptz not null default now(),
  unique (run_id, company_id, metric, instrument_key, scoring_version)
);
create index score_estimates_run_idx on score_estimates (run_id);
create index score_estimates_company_idx on score_estimates (company_id, scoring_version);
create trigger score_estimates_immutable
  before update or delete on score_estimates
  for each row execute function forbid_mutation();

-- Release 151: rollback data-loss guard used by every spec-151 down
-- section. A down that would drop rows refuses unless the operator ran it
-- with `scripts/migrate.ts down --allow-destructive-down` (which sets
-- rf.allow_destructive_down for that transaction only).
create function rf_refuse_destructive_down(tbls text[]) returns void
language plpgsql as $$
declare
  t text;
  n bigint;
begin
  if coalesce(current_setting('rf.allow_destructive_down', true), '') = 'on' then
    return;
  end if;
  foreach t in array tbls loop
    if to_regclass(t) is null then
      continue;
    end if;
    execute format('select count(*) from %I', t) into n;
    if n > 0 then
      raise exception 'refusing rollback: % holds % row(s) that would be lost. Export it, then re-run with --allow-destructive-down.', t, n;
    end if;
  end loop;
end;
$$;

-- +migrate down
select rf_refuse_destructive_down(array['competitor_cohorts', 'measurement_instruments', 'score_estimates']);
-- served_model / captured_at / matcher_version are provenance on immutable
-- rows; dropping them once populated loses history, so refuse the same way.
do $$
begin
  if coalesce(current_setting('rf.allow_destructive_down', true), '') <> 'on' and (
    exists (select 1 from responses where served_model is not null or captured_at is not null)
    or exists (select 1 from mentions where matcher_version is not null)
  ) then
    raise exception 'refusing rollback: responses/mentions carry spec-151 provenance that would be lost. Export, then re-run with --allow-destructive-down.';
  end if;
end;
$$;
drop table if exists score_estimates;
drop table if exists competitor_cohorts;
drop table if exists measurement_instruments;
alter table mentions drop column if exists matcher_version;
alter table responses
  drop column if exists captured_at,
  drop column if exists served_model;
drop function if exists rf_refuse_destructive_down(text[]);
