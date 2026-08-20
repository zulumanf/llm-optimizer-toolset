-- +migrate up
-- Spec 092: per-send open tracking. The token is minted at send time and
-- stored on the insert-only ledger row at insert (never an UPDATE); opens
-- are raw evidence rows — interpretation (proxy heuristics, dedup) happens
-- at read time and can be revised, the rows cannot.

alter table prospect_outreach_sends add column open_token text unique;

create table outreach_email_opens (
  id uuid primary key default gen_random_uuid(),
  send_id uuid not null references prospect_outreach_sends(id),
  opened_at timestamptz not null default now(),
  ip text,
  user_agent text
);
create index outreach_email_opens_send_idx on outreach_email_opens (send_id, opened_at);

create trigger outreach_email_opens_immutable
  before update or delete on outreach_email_opens
  for each row execute function forbid_mutation();

-- +migrate down
drop table outreach_email_opens;
alter table prospect_outreach_sends drop column open_token;
