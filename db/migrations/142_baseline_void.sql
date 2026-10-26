-- Spec 160: an audited, admin-only void for a wrongly frozen baseline.
--
-- The voided row is kept forever with its snapshot (still immutable); only
-- its status moves frozen -> voided, once, with who/when/why. The
-- one-frozen-baseline unique index is unchanged, so a void frees the slot.

-- +migrate up
alter table engagement_measurements drop constraint engagement_measurements_status_check;
alter table engagement_measurements add constraint engagement_measurements_status_check
  check (status in ('planned', 'frozen', 'non_comparable', 'failed', 'cancelled', 'voided'));

alter table engagement_measurements
  add column voided_at timestamptz,
  add column voided_by uuid references users(id),
  add column void_reason text;

alter table engagement_measurements add constraint engagement_measurements_voided_fields check (
  (status = 'voided') = (voided_at is not null and voided_by is not null and coalesce(length(trim(void_reason)), 0) > 0)
);

create or replace function engagement_measurement_snapshot_immutable()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'engagement_measurements rows are never deleted (spec 131)';
  end if;
  -- Spec 160: a voided row is final.
  if old.status = 'voided' and row(new.*) is distinct from row(old.*) then
    raise exception 'a voided measurement is final (spec 160)';
  end if;
  -- Spec 160: a frozen row may only move to voided.
  if old.status = 'frozen' and new.status is distinct from old.status and new.status <> 'voided' then
    raise exception 'a frozen measurement can only be voided (spec 160)';
  end if;
  if old.snapshot is not null and (
       new.snapshot is distinct from old.snapshot
    or new.run_id is distinct from old.run_id
    or new.frozen_at is distinct from old.frozen_at
    or new.prompt_set_version_id is distinct from old.prompt_set_version_id
    or new.provider is distinct from old.provider
    or new.subject_company_id is distinct from old.subject_company_id
    or new.competitor_company_ids is distinct from old.competitor_company_ids
  ) then
    raise exception 'a frozen measurement snapshot is immutable (spec 131)';
  end if;
  return new;
end $$;

-- +migrate down
do $$
begin
  if exists (select 1 from engagement_measurements where status = 'voided') then
    raise exception 'cannot roll back spec 160: voided baselines exist (audited history)';
  end if;
end $$;

create or replace function engagement_measurement_snapshot_immutable()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'engagement_measurements rows are never deleted (spec 131)';
  end if;
  if old.snapshot is not null and (
       new.snapshot is distinct from old.snapshot
    or new.run_id is distinct from old.run_id
    or new.frozen_at is distinct from old.frozen_at
    or new.prompt_set_version_id is distinct from old.prompt_set_version_id
    or new.provider is distinct from old.provider
    or new.subject_company_id is distinct from old.subject_company_id
    or new.competitor_company_ids is distinct from old.competitor_company_ids
  ) then
    raise exception 'a frozen measurement snapshot is immutable (spec 131)';
  end if;
  return new;
end $$;

alter table engagement_measurements drop constraint engagement_measurements_voided_fields;
alter table engagement_measurements
  drop column void_reason,
  drop column voided_by,
  drop column voided_at;
alter table engagement_measurements drop constraint engagement_measurements_status_check;
alter table engagement_measurements add constraint engagement_measurements_status_check
  check (status in ('planned', 'frozen', 'non_comparable', 'failed', 'cancelled'));
