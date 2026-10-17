-- +migrate up
-- Spec 151 A11 — classifier validation over REAL captured answers.
--
-- A gold sample is a seeded, stratified draw of (response, company) pairs.
-- Humans annotate blind (the classifier's label is never shown), one row per
-- annotator; disagreements are adjudicated by a person. Precision/recall
-- are computed only over pairs whose human label is unanimous (≥ 2
-- annotators) or adjudicated — a single annotator is reported separately,
-- never counted as validated. Nothing here is ever written by a model.
create table gold_samples (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  seed int not null,
  target_size int not null check (target_size > 0),
  strata jsonb not null default '{}',
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);

create table gold_sample_items (
  id uuid primary key default gen_random_uuid(),
  sample_id uuid not null references gold_samples(id),
  response_id uuid not null references responses(id),
  company_id uuid not null references companies(id),
  stratum text not null,
  position int not null,
  unique (sample_id, response_id, company_id),
  unique (sample_id, position)
);

create table gold_annotations (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references gold_sample_items(id),
  annotator_id uuid not null references users(id),
  same_entity boolean not null,
  mentioned boolean not null,
  recommended boolean not null,
  notes text,
  created_at timestamptz not null default now(),
  unique (item_id, annotator_id),
  check (mentioned or not recommended),
  check (same_entity or not mentioned)
);

create table gold_adjudications (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references gold_sample_items(id) unique,
  adjudicator_id uuid not null references users(id),
  same_entity boolean not null,
  mentioned boolean not null,
  recommended boolean not null,
  reason text not null,
  created_at timestamptz not null default now(),
  check (mentioned or not recommended),
  check (same_entity or not mentioned)
);

create trigger gold_samples_immutable before update or delete on gold_samples
  for each row execute function forbid_mutation();
create trigger gold_sample_items_immutable before update or delete on gold_sample_items
  for each row execute function forbid_mutation();
create trigger gold_annotations_immutable before update or delete on gold_annotations
  for each row execute function forbid_mutation();
create trigger gold_adjudications_immutable before update or delete on gold_adjudications
  for each row execute function forbid_mutation();

-- +migrate down
select rf_refuse_destructive_down(array['gold_annotations', 'gold_adjudications', 'gold_samples']);
drop table if exists gold_adjudications;
drop table if exists gold_annotations;
drop table if exists gold_sample_items;
drop table if exists gold_samples;
