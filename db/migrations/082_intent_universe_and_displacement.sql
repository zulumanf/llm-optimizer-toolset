-- Spec 087: real-estate intent universe + recommendation displacement.
--
-- Displacement itself is DERIVED from the immutable mention/citation ledgers
-- (lib/competitors/displacement.ts) and needs no table. This migration covers
-- the facts that are not derivable: structured prompt dimensions that are
-- currently baked into prompt text, a staging table so proposed prompt
-- variants are human-approved before they become measurement prompts, and the
-- new gap type the detector can emit.

-- +migrate up

-- 1. Structured real-estate dimensions on prompts. Free text like
-- audience/price_tier (migration 046): the market packs supply values, but
-- an operator typing a one-off prompt must not fight an enum.
alter table prompts add column neighborhood text;
alter table prompts add column building text;
alter table prompts add column property_type text;

-- 2. Prompt provenance widened: approved suggestions land as 'generated';
-- prompts transcribed from real observed user questions as 'observed'.
alter table prompts drop constraint prompts_source_check;
alter table prompts add constraint prompts_source_check check (source in (
  'manual', 'import', 'vertical_pack', 'expansion', 'generated', 'observed'
));

-- 3. Staged prompt suggestions (mirrors the enrichment_proposals lifecycle,
-- spec 078). Proposals never enter measurement until a human approves;
-- approval creates a real prompts row and records it here.
create table prompt_suggestions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id),
  prompt_set_id uuid not null references prompt_sets(id),
  text text not null,
  category text not null check (category in
    ('recommendation', 'comparison', 'how-to', 'branded', 'problem')),
  tier int check (tier between 1 and 4),
  audience text,
  price_tier text,
  neighborhood text,
  building text,
  property_type text,
  template_ref text,
  origin text not null check (origin in ('generated', 'observed')),
  rationale text not null,
  evidence jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'superseded')),
  generator_version text not null,
  promoted_prompt_id uuid references prompts(id),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  decided_by uuid references users(id),
  decided_at timestamptz
);
create index prompt_suggestions_set_status_idx
  on prompt_suggestions (prompt_set_id, status);
-- One live proposal per text per set; superseded/decided rows keep history.
create unique index prompt_suggestions_pending_dedup
  on prompt_suggestions (prompt_set_id, md5(lower(text)))
  where status = 'pending';

-- 4. New gap type: the subject is absent while named rivals collect the
-- recommendations (detail carries who, in which clusters, backed by what).
alter table gap_findings drop constraint gap_findings_gap_type_check;
alter table gap_findings add constraint gap_findings_gap_type_check check (gap_type in (
  'entity', 'branded_recognition', 'recommendation', 'citation',
  'category_share', 'source_target', 'displacement'
));

-- +migrate down
-- Displacement findings cannot survive the narrower check; delete rather
-- than silently remap (081 convention). Detector re-emits on re-analysis.
delete from gap_findings where gap_type = 'displacement';
alter table gap_findings drop constraint gap_findings_gap_type_check;
alter table gap_findings add constraint gap_findings_gap_type_check check (gap_type in (
  'entity', 'branded_recognition', 'recommendation', 'citation',
  'category_share', 'source_target'
));
drop table prompt_suggestions;
update prompts set source = 'manual' where source in ('generated', 'observed');
alter table prompts drop constraint prompts_source_check;
alter table prompts add constraint prompts_source_check check (source in (
  'manual', 'import', 'vertical_pack', 'expansion'
));
alter table prompts drop column property_type;
alter table prompts drop column building;
alter table prompts drop column neighborhood;
