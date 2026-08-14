-- +migrate up
-- Spec 062: intervention lifecycle. Status was inferred from run counts,
-- so nothing could be blocked, owned, or surfaced as attention. States are
-- observable facts, not aspirations; the pre-ship pipeline stays in tasks.
alter table interventions add column status text not null default 'shipped'
  check (status in ('shipped', 'retest_pending', 'blocked', 'retested', 'cancelled'));
alter table interventions add column blocked_reason text;
alter table interventions add column status_changed_at timestamptz not null default now();
alter table interventions add constraint interventions_blocked_need_reason
  check (status != 'blocked' or blocked_reason is not null);

-- Backfill mirrors the sync derivation (lib/attribution/lifecycle.ts):
-- a completed post run means verdicts exist; a scheduled or started post
-- means the retest is pending; everything else stays 'shipped'.
update interventions i set status = 'retested'
where exists (
  select 1 from intervention_runs ir
  join runs r on r.id = ir.run_id
  where ir.intervention_id = i.id and ir.role = 'post'
    and r.status in ('completed', 'partial')
);

update interventions i set status = 'retest_pending'
where i.status = 'shipped' and (
  exists (
    select 1 from intervention_runs ir
    where ir.intervention_id = i.id and ir.role = 'post'
  )
  or exists (
    select 1 from jobs j
    where j.type = 'start_scheduled_run' and j.status = 'queued'
      and j.payload->>'interventionId' = i.id::text
  )
);

create index interventions_status_idx on interventions (status)
  where archived_at is null;

-- +migrate down
drop index interventions_status_idx;
alter table interventions drop constraint interventions_blocked_need_reason;
alter table interventions drop column status_changed_at;
alter table interventions drop column blocked_reason;
alter table interventions drop column status;
