-- +migrate up
-- Spec 147 (slice 6): an operator-confirmed retry of an uncertain Gmail draft.
--
-- An attempt whose outcome is unknown, or that was orphaned, is never retried
-- automatically. When an operator confirms they checked Gmail and no usable
-- draft exists, the uncertain attempt is superseded (kept, never deleted) and
-- exactly one new attempt records which attempt it retries. The unique index
-- makes a repeated retry of the same attempt impossible at the database.
alter table profile_correction_drafts
  add column retry_of uuid references profile_correction_drafts(id),
  add column retry_requested_by uuid references users(id),
  add column retry_reason text,
  add constraint profile_correction_drafts_retry_complete check (
    (retry_of is null) = (retry_requested_by is null)
    and (retry_of is null) = (retry_reason is null)
  );

create unique index profile_correction_drafts_one_retry
  on profile_correction_drafts (retry_of) where retry_of is not null;

-- +migrate down
drop index if exists profile_correction_drafts_one_retry;
alter table profile_correction_drafts
  drop constraint if exists profile_correction_drafts_retry_complete,
  drop column if exists retry_reason,
  drop column if exists retry_requested_by,
  drop column if exists retry_of;
