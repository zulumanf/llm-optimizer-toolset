-- +migrate up
-- Spec 032 Phase 2.2/2.3: prospect contacts and CSV import support.
-- Outreach goes to a PERSON, not a business — do-not-contact must therefore
-- exist at both levels: the prospect (the account) and the contact (the
-- human). A draft addressed to a suppressed human is blocked even when the
-- account itself is fair game.

create table prospect_contacts (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid not null references prospects(id),
  name text not null,
  role text,
  email text,
  phone text,
  linkedin text,
  preferred_channel text check (preferred_channel is null or preferred_channel in
    ('email', 'linkedin_message', 'phone', 'warm_intro')),
  is_primary boolean not null default false,
  do_not_contact boolean not null default false,
  do_not_contact_reason text,
  provenance text not null default 'manual' check (provenance in
    ('verified', 'publicly_sourced', 'estimated', 'manual', 'ai_inferred')),
  notes text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create index prospect_contacts_prospect_idx
  on prospect_contacts (prospect_id) where archived_at is null;
-- One primary contact per prospect; same email may not repeat on a prospect.
create unique index prospect_contacts_one_primary
  on prospect_contacts (prospect_id) where is_primary and archived_at is null;
create unique index prospect_contacts_email_per_prospect
  on prospect_contacts (prospect_id, lower(email))
  where email is not null and archived_at is null;

-- A draft may name its recipient. Nullable: account-level drafts predate
-- contacts and remain valid.
alter table outreach_drafts add column contact_id uuid references prospect_contacts(id);
create index outreach_drafts_contact_idx
  on outreach_drafts (contact_id) where contact_id is not null;

-- +migrate down
drop index outreach_drafts_contact_idx;
alter table outreach_drafts drop column contact_id;
drop table prospect_contacts;
