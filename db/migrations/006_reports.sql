-- Spec 006: reports — immutable once published (docs/03, docs/07 step 8)

-- +migrate up
create table reports (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id),
  title text not null,
  period_start date not null,
  period_end date not null,
  body jsonb not null,
  status text not null default 'draft' check (status in ('draft', 'published')),
  created_at timestamptz not null default now(),
  published_by uuid,
  published_at timestamptz
);

create index reports_project_idx on reports (project_id);
-- One draft per (project, period) at a time (spec 006 validation)
create unique index reports_one_draft_per_period
  on reports (project_id, period_start, period_end)
  where status = 'draft';

-- Published reports are locked forever; drafts stay editable/deletable
create function forbid_published_report_mutation() returns trigger
language plpgsql as $$
begin
  if old.status = 'published' then
    raise exception '% on a published report is forbidden: reports are immutable once published (docs/07 step 8)',
      tg_op;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger reports_published_lock
  before update or delete on reports
  for each row execute function forbid_published_report_mutation();

-- +migrate down
drop trigger reports_published_lock on reports;
drop function forbid_published_report_mutation();
drop table reports;
