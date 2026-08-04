-- +migrate up
-- Stable audit links (operator request 2026-08-04): republishing an audit
-- keeps the SAME link — the token moves to the successor row and the old
-- row becomes 'superseded' (frozen, token slot vacated). Revocation keeps
-- its meaning: the link is burned and the next publish mints a fresh one.
-- "What a prospect saw is what we published" still holds — superseded
-- snapshots are as immutable as published ones.
alter table prospect_audits drop constraint prospect_audits_status_check;
alter table prospect_audits add constraint prospect_audits_status_check
  check (status in ('draft', 'published', 'revoked', 'superseded'));

create or replace function forbid_published_prospect_audit_mutation() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'DELETE on a prospect audit is forbidden: audits are archived by revocation';
  end if;
  -- The one new transition: published -> superseded, changing ONLY the
  -- status and vacating the token (it moves to the successor in the same
  -- transaction). Content, provenance, and timestamps stay frozen.
  if old.status = 'published' and new.status = 'superseded' then
    if new.access_token is not null
      or new.snapshot is distinct from old.snapshot
      or new.headline is distinct from old.headline
      or new.finding_id is distinct from old.finding_id
      or new.prospect_id is distinct from old.prospect_id
      or new.published_at is distinct from old.published_at
      or new.published_by is distinct from old.published_by then
      raise exception 'superseding may only change status and vacate the token (spec 032)';
    end if;
    return new;
  end if;
  if old.status in ('published', 'superseded') then
    if new.snapshot is distinct from old.snapshot
      or new.headline is distinct from old.headline
      or new.finding_id is distinct from old.finding_id
      or new.prospect_id is distinct from old.prospect_id
      or new.access_token is distinct from old.access_token
      or new.published_at is distinct from old.published_at
      or new.published_by is distinct from old.published_by then
      raise exception 'published prospect audits are immutable except for revocation (spec 032)';
    end if;
  end if;
  return new;
end;
$$;

-- +migrate down
update prospect_audits
  set status = 'revoked',
      revoked_at = coalesce(revoked_at, now()),
      revoke_reason = coalesce(revoke_reason, 'downgraded from superseded (057 down)')
  where status = 'superseded';
alter table prospect_audits drop constraint prospect_audits_status_check;
alter table prospect_audits add constraint prospect_audits_status_check
  check (status in ('draft', 'published', 'revoked'));

create or replace function forbid_published_prospect_audit_mutation() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'DELETE on a prospect audit is forbidden: audits are archived by revocation';
  end if;
  if old.status = 'published' then
    if new.snapshot is distinct from old.snapshot
      or new.headline is distinct from old.headline
      or new.finding_id is distinct from old.finding_id
      or new.prospect_id is distinct from old.prospect_id
      or new.access_token is distinct from old.access_token
      or new.published_at is distinct from old.published_at
      or new.published_by is distinct from old.published_by then
      raise exception 'published prospect audits are immutable except for revocation (spec 032)';
    end if;
  end if;
  return new;
end;
$$;
