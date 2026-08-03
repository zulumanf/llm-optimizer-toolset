-- +migrate up
-- Spec 039: the single configurable-weights mechanism, operator-recorded
-- fixability assessments, and the stored final prospect score.
--
-- Weight sets are versioned rows, one active per name. The final score is
-- STORED (unlike the derived-on-read spec-038 scores) because the list view
-- filters and sorts on it: a stored score is a snapshot an operator computed
-- at a known time; the breakdown records every component, weight, and
-- version that produced it. Recompute is an explicit audited action.

create table scoring_weight_sets (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  version int not null,
  weights jsonb not null,
  active boolean not null default false,
  notes text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (name, version)
);
create unique index scoring_weight_sets_one_active
  on scoring_weight_sets (name) where active;

-- Default final-score weights (target pipeline req. 17). Sum = 1.
-- Keys are camelCase: db/client.ts uses transform: postgres.camel, which
-- rewrites snake_case JSONB keys on read — snake keys here would come back
-- as different strings than were stored.
insert into scoring_weight_sets (name, version, weights, active, notes)
values (
  'prospect-final', 1,
  '{"commercialAuthority": 0.30, "visibilityGap": 0.25,
    "adjustedFixability": 0.20, "competitorAdvantage": 0.10,
    "buyingSignals": 0.10, "contactability": 0.05}'::jsonb,
  true,
  'Seeded default (spec 039). Null components redistribute their weight.'
);

-- Operator-recorded facts the platform cannot derive (website control,
-- publishing access, …). One row per item; the latest answer wins via
-- upsert. "unknown" is a recorded answer, distinct from never-asked.
create table prospect_assessments (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid not null references prospects(id),
  item text not null,
  value text not null check (value in ('yes', 'no', 'unknown')),
  note text,
  recorded_by uuid references users(id),
  recorded_at timestamptz not null default now(),
  unique (prospect_id, item)
);
create index prospect_assessments_prospect_idx on prospect_assessments (prospect_id);

-- The stored composite and its full explanation; override never erases the
-- computed value.
alter table prospects add column qualification_breakdown jsonb;
alter table prospects add column qualification_override int
  check (qualification_override between 0 and 100);
alter table prospects add column qualification_override_reason text;
alter table prospects add column qualification_override_by uuid references users(id);
alter table prospects add column qualification_override_at timestamptz;

-- +migrate down
alter table prospects drop column qualification_override_at;
alter table prospects drop column qualification_override_by;
alter table prospects drop column qualification_override_reason;
alter table prospects drop column qualification_override;
alter table prospects drop column qualification_breakdown;
drop table prospect_assessments;
drop table scoring_weight_sets;
