-- +migrate up
-- Spec 157: one-click unsubscribe (RFC 8058) for outreach email.
-- One random token per allowed Gmail send, written BEFORE dispatch and
-- outside the send transaction, so the link in a delivered message works
-- even if the ledger transaction later rolls back. Insert-only: redemption
-- is recorded as a suppression entry (+ audit), never as an update here.
-- prospect_id / draft_id are provenance WITHOUT foreign keys, deliberately:
-- the send transaction holds the draft row FOR UPDATE, and an FK check from
-- this independent insert would wait on it — a self-deadlock (reproduced).
create table outreach_unsubscribe_tokens (
  token text primary key check (token ~ '^[0-9a-f]{32}$'),
  recipient_email text not null,
  prospect_id uuid,
  draft_id uuid,
  created_at timestamptz not null default now()
);
create index outreach_unsubscribe_tokens_prospect_idx on outreach_unsubscribe_tokens (prospect_id);
create trigger outreach_unsubscribe_tokens_immutable before update or delete on outreach_unsubscribe_tokens
  for each row execute function forbid_mutation();

-- +migrate down
select rf_refuse_destructive_down(array['outreach_unsubscribe_tokens']);
drop table if exists outreach_unsubscribe_tokens;
