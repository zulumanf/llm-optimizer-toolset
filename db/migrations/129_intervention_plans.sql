-- +migrate up
-- Spec 151 B4 — intervention pre-registration.
--
-- A plan states, BEFORE the change ships, what will be measured and against
-- what. Drafts are editable; an approved plan is frozen: the only permitted
-- changes are linking the intervention that records what shipped (once,
-- from null) and retiring the plan (approved → superseded | withdrawn).
-- A changed plan is a new version (same plan_key, supersedes → old id).
create table intervention_plans (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id),
  plan_key uuid not null default gen_random_uuid(),
  version int not null default 1 check (version >= 1),
  supersedes uuid references intervention_plans(id),
  status text not null default 'draft'
    check (status in ('draft', 'approved', 'superseded', 'withdrawn')),
  hypothesis text not null,
  intervention_type text not null,
  entity_company_id uuid not null references companies(id),
  target_intent text,
  target_prompt_ids uuid[] not null default '{}',
  control_prompt_ids uuid[] not null default '{}',
  control_company_ids uuid[] not null default '{}',
  instrument_key text not null,
  primary_metric text not null check (primary_metric in
    ('recommendation_rate', 'mention_rate', 'owned_citation_rate', 'top_three_rate', 'first_position_rate')),
  expected_direction text not null check (expected_direction in ('increase', 'decrease')),
  mde numeric check (mde > 0 and mde <= 1),
  design text not null check (design in
    ('descriptive', 'matched_comparison', 'preregistered_controlled', 'staggered')),
  planned_implementation text not null,
  measurement_schedule text[] not null default '{+2w,+6w,+12w}',
  known_confounders text[] not null default '{}',
  baseline_run_ids uuid[] not null default '{}',
  estimated_cost_usd numeric check (estimated_cost_usd >= 0),
  opportunity_id uuid references opportunities(id),
  intervention_id uuid references interventions(id),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  approved_by uuid references users(id),
  approved_at timestamptz,
  unique (plan_key, version),
  check ((status = 'draft') = (approved_at is null) or status in ('superseded', 'withdrawn'))
);
create index intervention_plans_project_idx on intervention_plans (project_id, status);
create unique index intervention_plans_one_live_per_key
  on intervention_plans (plan_key) where status in ('draft', 'approved');

create function intervention_plan_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'delete on intervention_plans is forbidden: plans are evidence (PRINCIPLES.md #3)';
  end if;
  if old.status = 'draft' then
    return new;
  end if;
  if old.status in ('superseded', 'withdrawn') then
    raise exception 'intervention plan % is retired and immutable', old.id;
  end if;
  -- old.status = 'approved': frozen except the two permitted moves
  if (to_jsonb(new) - 'status' - 'intervention_id') <> (to_jsonb(old) - 'status' - 'intervention_id') then
    raise exception 'approved intervention plan % is frozen; create a new version', old.id;
  end if;
  if new.status not in ('approved', 'superseded', 'withdrawn') then
    raise exception 'approved intervention plan % cannot return to %', old.id, new.status;
  end if;
  if old.intervention_id is not null and new.intervention_id is distinct from old.intervention_id then
    raise exception 'intervention plan % is already linked to an intervention', old.id;
  end if;
  return new;
end;
$$;

create trigger intervention_plans_guard
  before update or delete on intervention_plans
  for each row execute function intervention_plan_guard();

-- +migrate down
select rf_refuse_destructive_down(array['intervention_plans']);
drop trigger if exists intervention_plans_guard on intervention_plans;
drop function if exists intervention_plan_guard();
drop table if exists intervention_plans;
