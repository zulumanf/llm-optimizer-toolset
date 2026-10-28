-- +migrate up
-- Spec 152: performance pricing. An engagement may carry a performance fee
-- that is owed only when the founder records an agreed, frozen target as met
-- against a remeasurement snapshot. total_value_usd keeps meaning the fixed,
-- contracted fee. pricing_quotes needs no change: the performance fee rides
-- the already-frozen billing_structure jsonb. billing_events is unchanged:
-- the performance invoice uses the deterministic id ENG-<id8>-P.
-- Numbered 127: production is at 126 (126_outreach_unsubscribe_tokens).
alter table client_engagements
  add column performance_fee_usd numeric
    check (performance_fee_usd is null or performance_fee_usd >= 0),
  add column performance_target jsonb,
  add column performance_outcome text not null default 'not_applicable'
    check (performance_outcome in ('not_applicable', 'pending', 'met', 'not_met')),
  add column performance_outcome_snapshot_id uuid references engagement_measurements(id),
  add column performance_outcome_by uuid references users(id),
  add column performance_outcome_at timestamptz,
  add column performance_outcome_note text;

-- A performance outcome only exists with a fee; a decided outcome always
-- cites its target, its remeasurement snapshot, who and when.
alter table client_engagements add constraint client_engagements_performance_fee_present
  check (performance_outcome = 'not_applicable' or performance_fee_usd is not null);
alter table client_engagements add constraint client_engagements_performance_outcome_cited
  check (
    performance_outcome not in ('met', 'not_met')
    or (performance_target is not null and performance_outcome_snapshot_id is not null
        and performance_outcome_by is not null and performance_outcome_at is not null)
  );

-- The target freezes once work starts (stage leaves signed/onboarding) or
-- once the outcome is decided. The outcome moves pending -> met | not_met
-- exactly once and never back; a decided outcome's citation never changes.
-- Nothing here decides "met": only a founder-recorded row update does.
create or replace function client_engagement_performance_guard()
returns trigger language plpgsql as $$
begin
  if new.performance_target is distinct from old.performance_target
     and (old.stage not in ('signed', 'onboarding') or old.performance_outcome in ('met', 'not_met')) then
    raise exception 'the performance target is immutable once work starts or the outcome is recorded (spec 152)';
  end if;
  if new.performance_outcome is distinct from old.performance_outcome
     and not (old.performance_outcome = 'pending' and new.performance_outcome in ('met', 'not_met')) then
    raise exception 'the performance outcome moves pending -> met | not_met once, never back (spec 152)';
  end if;
  if old.performance_outcome in ('met', 'not_met') and (
       new.performance_fee_usd is distinct from old.performance_fee_usd
    or new.performance_outcome_snapshot_id is distinct from old.performance_outcome_snapshot_id
    or new.performance_outcome_by is distinct from old.performance_outcome_by
    or new.performance_outcome_at is distinct from old.performance_outcome_at
    or new.performance_outcome_note is distinct from old.performance_outcome_note
  ) then
    raise exception 'a recorded performance outcome is immutable (spec 152)';
  end if;
  return new;
end $$;
create trigger client_engagements_performance_guard
  before update on client_engagements
  for each row execute function client_engagement_performance_guard();

-- +migrate down
drop trigger if exists client_engagements_performance_guard on client_engagements;
drop function if exists client_engagement_performance_guard();
alter table client_engagements drop constraint if exists client_engagements_performance_outcome_cited;
alter table client_engagements drop constraint if exists client_engagements_performance_fee_present;
alter table client_engagements
  drop column if exists performance_outcome_note,
  drop column if exists performance_outcome_at,
  drop column if exists performance_outcome_by,
  drop column if exists performance_outcome_snapshot_id,
  drop column if exists performance_outcome,
  drop column if exists performance_target,
  drop column if exists performance_fee_usd;
