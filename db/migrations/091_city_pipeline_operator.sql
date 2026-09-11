-- +migrate up
-- Spec 102: the assistant manages what it starts. A pipeline can be
-- cancelled (human-confirmed), and a failed one remembers which status it
-- failed from so a retry resumes there instead of re-running the city.

alter table city_prospecting_pipelines
  drop constraint city_prospecting_pipelines_status_check;
alter table city_prospecting_pipelines
  add constraint city_prospecting_pipelines_status_check
  check (status in ('installing','discovering','seeding','benchmarking','running','scoring','completed','failed','cancelled'));

alter table city_prospecting_pipelines add column failed_from_status text;

-- The tick selects by this index; without 'cancelled' in the predicate a
-- cancelled pipeline would be picked up forever.
drop index city_prospecting_pipelines_active_idx;
create index city_prospecting_pipelines_active_idx
  on city_prospecting_pipelines (status)
  where status not in ('completed','failed','cancelled');

-- +migrate down
-- Cancelled rows cannot survive the old constraint: map them to failed,
-- preserving why in error (spec 102 rollback note).
update city_prospecting_pipelines
  set status = 'failed',
    error = coalesce(error, 'cancelled (rolled back from spec 102)')
  where status = 'cancelled';

alter table city_prospecting_pipelines drop column failed_from_status;

alter table city_prospecting_pipelines
  drop constraint city_prospecting_pipelines_status_check;
alter table city_prospecting_pipelines
  add constraint city_prospecting_pipelines_status_check
  check (status in ('installing','discovering','seeding','benchmarking','running','scoring','completed','failed'));

drop index city_prospecting_pipelines_active_idx;
create index city_prospecting_pipelines_active_idx
  on city_prospecting_pipelines (status)
  where status not in ('completed','failed');
