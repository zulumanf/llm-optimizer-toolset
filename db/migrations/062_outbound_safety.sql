-- +migrate up
-- Spec 052: make manual outbound truthful and safe.

-- Sender identity (audit 8.5/8.10): outbound email had no sender-identity
-- record and the opt-out footer lacked the physical postal address CAN-SPAM
-- requires. One active row; changes append + deactivate (history is audit
-- evidence). Cold sends REFUSE until an admin configures this — the missing
-- operator decision blocks sends instead of producing non-compliant ones.
create table outreach_sender_identity (
  id uuid primary key default gen_random_uuid(),
  sender_name text not null,
  company_name text not null,
  postal_address text not null,
  reply_to_email text not null,
  active boolean not null default true,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
create unique index outreach_sender_identity_one_active
  on outreach_sender_identity (active) where active;

-- Territory reservation (audit 10.5): status was active|terminated only, so
-- a prospect in late-stage negotiation reserved nothing and two conflicting
-- prospects in one market could be worked in parallel. Reserved occupies
-- the territory in conflict detection exactly like active.
alter table exclusivity_agreements drop constraint exclusivity_agreements_status_check;
alter table exclusivity_agreements add constraint exclusivity_agreements_status_check
  check (status in ('active', 'reserved', 'terminated'));

-- PII erasure marker (audit F26/F27): contact PII is deletable on request;
-- the timestamp records that an erasure happened without keeping what was
-- erased. The suppression tombstone (normalized email match key) is what
-- must survive, and it lives in the suppression list.
alter table prospect_contacts add column pii_erased_at timestamptz;

-- +migrate down
alter table prospect_contacts drop column pii_erased_at;
update exclusivity_agreements set status = 'active' where status = 'reserved';
alter table exclusivity_agreements drop constraint exclusivity_agreements_status_check;
alter table exclusivity_agreements add constraint exclusivity_agreements_status_check
  check (status in ('active', 'terminated'));
drop table outreach_sender_identity;
