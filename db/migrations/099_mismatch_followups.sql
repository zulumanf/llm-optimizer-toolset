-- Spec 127: competitive-mismatch follow-up sequences (Touch 2 / Touch 3).
-- One row per (prospect, experiment) carries the FROZEN Touch 1 evidence
-- and the sequence state; touch drafts stay ordinary outreach_drafts (same
-- approval, QA, gate, ledger, worker) tagged with their sequence, touch,
-- branch and the engagement state that chose the branch. Sends learn
-- their Gmail thread so replies can be threaded and inspected; replies
-- learn their Gmail message id so ingestion is idempotent.

-- +migrate up
create table outreach_followup_sequences (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid not null references prospects(id),
  experiment_id text not null,
  contact_id uuid references prospect_contacts(id),
  touch1_draft_id uuid not null references outreach_drafts(id),
  touch1_send_id uuid not null references prospect_outreach_sends(id),
  competitor_company_id uuid not null references companies(id),
  evidence_snapshot jsonb not null,
  distinct_competitor_questions integer not null default 0,
  timezone text not null,
  status text not null default 'active'
    check (status in ('active', 'paused', 'replied', 'stopped', 'complete')),
  stop_reason text,
  paused_until timestamptz,
  pause_reason text,
  next_touch integer check (next_touch in (2, 3)),
  next_due_at timestamptz,
  last_touch_send_id uuid references prospect_outreach_sends(id),
  enrolled_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (prospect_id, experiment_id)
);
create index outreach_followup_sequences_due_idx
  on outreach_followup_sequences (status, next_due_at);

alter table outreach_drafts
  add column sequence_id uuid references outreach_followup_sequences(id),
  add column touch_number integer check (touch_number in (2, 3)),
  add column branch text,
  add column parent_send_id uuid references prospect_outreach_sends(id),
  add column engagement_state_at_dispatch text;
-- One live (approved, unsent) draft per touch per sequence: no duplicate
-- Touch 2 / Touch 3 can ever be queued.
create unique index outreach_drafts_sequence_touch_live_idx
  on outreach_drafts (sequence_id, touch_number)
  where sequence_id is not null and status = 'approved' and sent_recorded_at is null;

alter table prospect_outreach_sends add column gmail_thread_id text;

alter table prospect_replies add column gmail_message_id text;
create unique index prospect_replies_gmail_message_idx
  on prospect_replies (gmail_message_id) where gmail_message_id is not null;

-- +migrate down
drop index prospect_replies_gmail_message_idx;
alter table prospect_replies drop column gmail_message_id;
alter table prospect_outreach_sends drop column gmail_thread_id;
drop index outreach_drafts_sequence_touch_live_idx;
alter table outreach_drafts
  drop column engagement_state_at_dispatch,
  drop column parent_send_id,
  drop column branch,
  drop column touch_number,
  drop column sequence_id;
drop table outreach_followup_sequences;
