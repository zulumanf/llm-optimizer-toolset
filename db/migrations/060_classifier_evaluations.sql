-- +migrate up
-- Spec 050: persisted gold-set evaluations of the PRODUCTION classifier.
-- The only CI-gated accuracy corpus tested the deprecated heuristic parser;
-- the LLM classifier that actually produces every client metric's numerator
-- had no accuracy measurement. Each run of scripts/eval-classifier.ts (or
-- the CI stub harness) writes one row here, so accuracy is comparable
-- across prompt versions and models instead of vanishing into a terminal.
-- Insert-only: an evaluation is a measurement.
create table classifier_evaluations (
  id uuid primary key default gen_random_uuid(),
  gold_set_version text not null,
  classifier_prompt_version text not null,
  classifier_model text not null,
  cases_total int not null,
  pairs_total int not null,
  precision_mentioned numeric,
  recall_mentioned numeric,
  precision_recommended numeric,
  recall_recommended numeric,
  entity_rejection_accuracy numeric,
  passed boolean not null,
  -- Per-pair mismatches: [{caseId, companyId, field, expected, actual}]
  failures jsonb not null default '[]',
  -- 'live' = real model via scripts/eval-classifier.ts; 'stub' = CI math check
  mode text not null check (mode in ('live', 'stub')),
  evaluated_at timestamptz not null default now()
);

create index classifier_evaluations_at_idx on classifier_evaluations (evaluated_at);

-- Reuses forbid_mutation() from migration 001.
create trigger classifier_evaluations_immutable
  before update or delete on classifier_evaluations
  for each row execute function forbid_mutation();

-- +migrate down
drop table classifier_evaluations;
