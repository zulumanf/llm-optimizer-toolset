-- +migrate up
-- Release 151 — offline evaluation of intervention predictions (the RF
-- Adaptive Intervention Engine, evaluation only; nothing here acts).
--
-- A prediction is a statement, made BEFORE a change ships, about the
-- pre-registered plan's primary metric on its pinned instrument: a point
-- change, an interval, and a probability that the evaluator will report
-- "improvement observed". It is scored later against the evaluator's
-- verdict (lib/experiments/evaluate.ts) — an observed association under the
-- plan's design, never a causal effect. Insert-only; a revised prediction is
-- a new row, and only rows recorded before shipping are ever scored.
create table intervention_predictions (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references intervention_plans(id),
  predictor text not null,
  predictor_version text not null,
  basis text not null check (basis in ('no_change_baseline', 'descriptive_prior', 'rule', 'human')),
  predicted_change numeric not null check (predicted_change between -1 and 1),
  interval_level numeric not null default 0.8 check (interval_level > 0 and interval_level < 1),
  predicted_low numeric not null,
  predicted_high numeric not null,
  probability_improvement numeric not null check (probability_improvement between 0 and 1),
  rationale text not null,
  features jsonb not null default '{}',
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  check (predicted_low <= predicted_change and predicted_change <= predicted_high)
);
create index intervention_predictions_plan_idx on intervention_predictions (plan_id);
create trigger intervention_predictions_immutable before update or delete on intervention_predictions
  for each row execute function forbid_mutation();

-- +migrate down
select rf_refuse_destructive_down(array['intervention_predictions']);
drop table if exists intervention_predictions;
