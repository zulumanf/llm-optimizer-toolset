-- +migrate up
-- Spec 043: the prospect send ledger. Every dispatch — and every refusal —
-- through sendProspectDraft leaves a row with the full gate verdict and the
-- sha256 of the exact text that went out. Insert-only: the ledger is
-- evidence, and evidence does not get edited.

create table prospect_outreach_sends (
  id uuid primary key default gen_random_uuid(),
  draft_id uuid not null references outreach_drafts(id),
  prospect_id uuid not null references prospects(id),
  channel text not null check (channel in ('manual', 'mock')),
  recipient_email text,
  body_hash text not null,
  business_purpose text not null,
  -- Every check that ran, with pass/fail and detail (camelCase keys —
  -- postgres.camel rewrites snake_case JSONB keys on read, DECISIONS.md).
  gate_verdict jsonb not null,
  allowed boolean not null,
  provider_message_id text,
  sent_by uuid references users(id),
  sent_at timestamptz not null default now()
);
create index prospect_outreach_sends_draft_idx on prospect_outreach_sends (draft_id);
create index prospect_outreach_sends_prospect_idx on prospect_outreach_sends (prospect_id);

create trigger prospect_outreach_sends_immutable
  before update or delete on prospect_outreach_sends
  for each row execute function forbid_mutation();

-- +migrate down
drop table prospect_outreach_sends;
