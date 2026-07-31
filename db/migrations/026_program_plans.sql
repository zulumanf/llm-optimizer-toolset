-- Spec 026: 90-day program plans.
--
-- The platform could rank findings and turn one finding into one task, but it
-- could not answer the question a client actually asks: what will you do over
-- the next three months, in what order, and how will we know it worked?
--
-- Design notes the column list does not carry:
--  * A plan is COMPOSED, never generated. Every item points at the finding
--    that produced it, so "why is this on the list?" always has an answer that
--    is not "the model suggested it".
--  * Re-composing supersedes rather than overwrites. A plan shown to a client
--    in March must still render in June exactly as it did — the same rule that
--    governs prompt set versions and wiki pages.
--  * The baseline is snapshotted into the plan row. Comparing progress against
--    "the numbers today" is not a comparison; comparing against the numbers at
--    composition time is.
--  * Excluded plays are STORED, with a reason. An operator needs to see that
--    "claim the Zillow profile" was skipped for want of Zillow data, rather
--    than wonder why it never appeared.

-- +migrate up

create table program_plans (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id),
  title text not null,
  horizon_days integer not null default 90 check (horizon_days between 30 and 365),
  status text not null default 'draft'
    check (status in ('draft', 'approved', 'active', 'completed', 'superseded')),

  -- What the plan was composed from, frozen at composition time.
  baseline_run_id uuid references runs(id),
  baseline jsonb not null default '{}'::jsonb,
  finding_ids uuid[] not null default '{}',

  composer_version text not null,
  -- Same findings + same templates ⇒ same hash. Re-composing an unchanged
  -- picture is then visibly a no-op rather than a new plan with a new date.
  composition_hash text not null,

  supersedes_id uuid references program_plans(id),
  superseded_at timestamptz,
  approved_by uuid,
  approved_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index program_plans_project_idx on program_plans (project_id, created_at desc);
-- At most one live plan per client: two active plans is two answers to the
-- same question.
create unique index program_plans_one_active
  on program_plans (project_id)
  where status in ('approved', 'active');

create table plan_items (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references program_plans(id) on delete cascade,
  phase text not null check (phase in ('foundation', 'authority', 'compounding')),
  -- Rank within the phase, from the source finding's opportunity score.
  position smallint not null,
  play_key text not null,
  title text not null,
  rationale text not null,

  -- Traceability: the finding that produced this item and the evidence behind
  -- it. A plan item with neither is not a plan item, it is an opinion.
  source_finding_id uuid references gap_findings(id),
  evidence_ids uuid[] not null default '{}',
  claim_ids uuid[] not null default '{}',

  effort_hours numeric(6,2) not null default 0,
  owner text not null default 'operator'
    check (owner in ('operator', 'client', 'shared')),
  -- What to re-measure afterwards. A movement to observe, never a promise.
  measurement text not null default '',

  status text not null default 'planned'
    check (status in ('planned', 'excluded', 'in_progress', 'done', 'dropped')),
  -- Populated only when status = 'excluded'. Required by a check so an
  -- exclusion can never be silent.
  exclusion_reason text,
  task_id uuid references tasks(id),
  created_at timestamptz not null default now(),

  constraint plan_items_exclusion_has_reason check (
    status <> 'excluded' or (exclusion_reason is not null and length(exclusion_reason) > 0)
  )
);
create index plan_items_plan_idx on plan_items (plan_id, phase, position);
create unique index plan_items_unique_play on plan_items (plan_id, play_key);

-- +migrate down
drop table plan_items;
drop index program_plans_one_active;
drop table program_plans;
