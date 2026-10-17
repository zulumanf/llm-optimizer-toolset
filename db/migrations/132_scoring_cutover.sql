-- +migrate up
-- Release 151 — backward-compatible scoring cutover.
--
-- One row decides which scoring version every `scores` reader sees
-- (`read_version`) and whether the legacy v1.1 writer still runs
-- (`write_legacy`). It starts at v1.1 / true, so deploying spec 151 changes
-- nothing any dashboard shows. `scripts/scoring-cutover.ts` flips it after
-- verifying v1.2 coverage; rollback is flipping it back. Every flip is an
-- insert-only history row.
create table scoring_state (
  id int primary key default 1 check (id = 1),
  read_version text not null default 'v1.1' check (read_version in ('v1.1', 'v1.2')),
  write_legacy boolean not null default true,
  -- v1.1 cannot be retired while it is still what readers see
  check (write_legacy or read_version <> 'v1.1'),
  updated_at timestamptz not null default now()
);
insert into scoring_state (id) values (1);

create table scoring_state_history (
  id uuid primary key default gen_random_uuid(),
  read_version text not null,
  write_legacy boolean not null,
  reason text not null,
  verification jsonb not null default '{}',
  changed_by text not null,
  changed_at timestamptz not null default now()
);
create trigger scoring_state_history_immutable before update or delete on scoring_state_history
  for each row execute function forbid_mutation();

-- +migrate down
-- Never drop the switch while readers are on v1.2: old code would read v1.1
-- rows that the retired legacy writer may no longer produce.
do $$
begin
  if exists (select 1 from scoring_state where read_version <> 'v1.1' or not write_legacy) then
    raise exception 'refusing rollback: scoring_state is past the v1.1 baseline. Run scripts/scoring-cutover.ts rollback first.';
  end if;
end;
$$;
select rf_refuse_destructive_down(array['scoring_state_history']);
drop table if exists scoring_state_history;
drop table if exists scoring_state;
