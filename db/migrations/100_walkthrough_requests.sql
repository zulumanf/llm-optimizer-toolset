-- Spec 128: a prospect picks a time for the report walkthrough from the
-- private report itself. Insert-only from the prospect's side; the operator
-- confirms by email. One row per pick; the audit token is the credential.

-- +migrate up
create table prospect_walkthrough_requests (
  id uuid primary key default gen_random_uuid(),
  audit_id uuid not null references prospect_audits(id),
  prospect_id uuid not null references prospects(id),
  slot_at timestamptz not null,
  timezone text not null,
  contact text,
  note text check (note is null or char_length(note) <= 1000),
  notified_at timestamptz,
  notify_error text,
  ip text,
  user_agent text,
  created_at timestamptz not null default now()
);
create index prospect_walkthrough_requests_prospect_idx
  on prospect_walkthrough_requests (prospect_id, created_at desc);

-- +migrate down
drop table prospect_walkthrough_requests;
