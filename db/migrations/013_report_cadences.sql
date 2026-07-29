-- Spec 016: report cadences (weekly pulse / monthly / quarterly)

-- +migrate up
alter table reports add column kind text not null default 'monthly'
  check (kind in ('weekly_pulse', 'monthly', 'quarterly'));

-- The one-draft-per-period rule becomes one draft per period PER KIND:
-- a weekly pulse and a monthly report can legitimately cover overlapping
-- periods (spec 016).
drop index if exists reports_one_draft_per_period;
create unique index reports_one_draft_per_period
  on reports (project_id, kind, period_start, period_end)
  where status = 'draft';

-- +migrate down
drop index reports_one_draft_per_period;
create unique index reports_one_draft_per_period
  on reports (project_id, period_start, period_end) where status = 'draft';
alter table reports drop column kind;
