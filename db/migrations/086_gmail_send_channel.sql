-- +migrate up
-- Spec 091: the platform's first transmitting email channel. 'gmail' joins
-- the send-ledger channel domain, and approved drafts gain a human-named
-- schedule so the worker can transmit a confirmed send at its time.
--
-- The scheduling columns are deliberately NOT in the approved-draft
-- immutability list (migration 038's trigger): the approved TEXT stays
-- frozen; when and whether the approved artifact transmits is operational
-- state that must remain writable.

alter table prospect_outreach_sends drop constraint prospect_outreach_sends_channel_check;
alter table prospect_outreach_sends add constraint prospect_outreach_sends_channel_check
  check (channel in ('manual', 'mock', 'gmail'));

alter table outreach_drafts
  -- The human-named transmission time. Set only by scheduleDraftSend,
  -- cleared by cancel, supersede, or a terminal send-time refusal.
  add column scheduled_send_at timestamptz,
  add column scheduled_by uuid references users(id),
  -- Stated legitimate-interest basis, recorded at scheduling time so the
  -- worker's ledger row carries the human's words, not a system default.
  add column scheduled_business_purpose text,
  -- Dispatch bookkeeping. send_claimed_at doubles as an in-flight marker:
  -- a claim that never recorded an outcome means the worker died mid-send,
  -- and that draft must never be auto-retried (possible double-send).
  add column send_attempts int not null default 0,
  add column send_claimed_at timestamptz,
  add column last_send_error text;

create index outreach_drafts_scheduled_idx on outreach_drafts (scheduled_send_at)
  where scheduled_send_at is not null and sent_recorded_at is null;

-- +migrate down
-- Restoring the two-value check refuses while gmail ledger rows exist —
-- correct: evidence rows must not be orphaned by a rollback.
alter table prospect_outreach_sends drop constraint prospect_outreach_sends_channel_check;
alter table prospect_outreach_sends add constraint prospect_outreach_sends_channel_check
  check (channel in ('manual', 'mock'));

drop index outreach_drafts_scheduled_idx;
alter table outreach_drafts
  drop column scheduled_send_at,
  drop column scheduled_by,
  drop column scheduled_business_purpose,
  drop column send_attempts,
  drop column send_claimed_at,
  drop column last_send_error;
