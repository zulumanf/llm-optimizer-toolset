-- Spec 140: first-client purchase path. A quote is prepared by the founder
-- (draft), presented (frozen), accepted; an agreement artifact is rendered
-- from the frozen quote and, once sent or signed, never regenerated over;
-- an engagement binds to exactly one accepted quote (idempotent creation).
-- Historical quotes (Ryan Ogle, founder_monthly_7500_v0) are untouched: the
-- new statuses and columns are additive and the immutability trigger only
-- forbids what was already forbidden by policy.
-- Numbered 112 because 111 is claimed by the concurrent spec 138 branch.

-- +migrate up
alter table pricing_quotes drop constraint pricing_quotes_status_check;
alter table pricing_quotes add constraint pricing_quotes_status_check
  check (status in ('draft', 'presented', 'accepted', 'declined', 'withdrawn', 'superseded'));
alter table pricing_quotes add column presented_at timestamptz;
alter table pricing_quotes add column scope_version text not null default '';
alter table pricing_quotes add column superseded_by uuid references pricing_quotes(id);
-- Every pre-existing row was recorded from an allowed send: presented then.
update pricing_quotes set presented_at = quoted_at where presented_at is null and status <> 'draft';

-- Commercial fields freeze the moment a quote leaves draft. Outcome fields
-- (status forward, objections, response, engagement link) stay writable.
create or replace function pricing_quote_commercial_immutable()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'pricing_quotes rows are never deleted (spec 140)';
  end if;
  if old.status <> 'draft' and (
       new.pricing_policy_version is distinct from old.pricing_policy_version
    or new.offer_name is distinct from old.offer_name
    or new.total_fee_usd is distinct from old.total_fee_usd
    or new.term_days is distinct from old.term_days
    or new.billing_structure is distinct from old.billing_structure
    or new.quoted_at is distinct from old.quoted_at
    or new.presented_at is distinct from old.presented_at
    or new.prospect_id is distinct from old.prospect_id
    or new.market_id is distinct from old.market_id
    or new.scope_version is distinct from old.scope_version
    or new.default_total_fee_usd is distinct from old.default_total_fee_usd
    or new.override_reason is distinct from old.override_reason
  ) then
    raise exception 'a presented quote''s commercial terms are immutable (spec 140)';
  end if;
  if old.status <> 'draft' and new.status in ('draft', 'superseded') then
    raise exception 'a presented quote never returns to draft (spec 140)';
  end if;
  return new;
end $$;
create trigger pricing_quotes_commercial_immutable
  before update or delete on pricing_quotes
  for each row execute function pricing_quote_commercial_immutable();

-- The agreement artifact: rendered from the frozen quote under a template
-- version, with the legal-review status recorded truthfully. No signature
-- provider exists; sent/signed are recorded states with a reference.
create table engagement_agreements (
  id uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references client_engagements(id),
  project_id uuid not null references projects(id),
  quote_id uuid references pricing_quotes(id),
  template_version text not null,
  legal_review_status text not null default 'NOT_REVIEWED'
    check (legal_review_status in ('NOT_REVIEWED', 'REVIEWED')),
  status text not null default 'draft'
    check (status in ('draft', 'sent', 'signed', 'void')),
  content_md text not null,
  content_hash text not null,
  snapshot jsonb not null,
  sent_at timestamptz,
  signed_at timestamptz,
  signed_ref text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint engagement_agreements_signed_has_ref check (
    status <> 'signed' or (signed_ref is not null and signed_at is not null)
  )
);
create index engagement_agreements_engagement_idx on engagement_agreements (engagement_id, created_at desc);
-- One live (sent or signed) agreement per engagement.
create unique index engagement_agreements_one_live
  on engagement_agreements (engagement_id) where status in ('sent', 'signed');

create or replace function engagement_agreement_immutable()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'engagement_agreements rows are never deleted (spec 140)';
  end if;
  if old.status in ('sent', 'signed') and (
       new.content_md is distinct from old.content_md
    or new.content_hash is distinct from old.content_hash
    or new.snapshot is distinct from old.snapshot
    or new.quote_id is distinct from old.quote_id
    or new.template_version is distinct from old.template_version
    or new.engagement_id is distinct from old.engagement_id
  ) then
    raise exception 'a sent or signed agreement is immutable (spec 140)';
  end if;
  if old.status = 'signed' and new.status <> 'signed' then
    raise exception 'a signed agreement stays signed (spec 140)';
  end if;
  return new;
end $$;
create trigger engagement_agreements_immutable
  before update or delete on engagement_agreements
  for each row execute function engagement_agreement_immutable();

-- The engagement binds to the accepted quote it was created from and names
-- the client's legal entity for the agreement. One engagement per quote.
alter table client_engagements add column quote_id uuid references pricing_quotes(id);
alter table client_engagements add column client_legal_name text not null default '';
create unique index client_engagements_one_per_quote
  on client_engagements (quote_id) where quote_id is not null;

-- +migrate down
drop index client_engagements_one_per_quote;
alter table client_engagements drop column client_legal_name;
alter table client_engagements drop column quote_id;
drop trigger engagement_agreements_immutable on engagement_agreements;
drop function engagement_agreement_immutable();
drop table engagement_agreements;
drop trigger pricing_quotes_commercial_immutable on pricing_quotes;
drop function pricing_quote_commercial_immutable();
alter table pricing_quotes drop column superseded_by;
alter table pricing_quotes drop column scope_version;
alter table pricing_quotes drop column presented_at;
update pricing_quotes set status = 'presented' where status in ('draft', 'superseded');
alter table pricing_quotes drop constraint pricing_quotes_status_check;
alter table pricing_quotes add constraint pricing_quotes_status_check
  check (status in ('presented', 'accepted', 'declined', 'withdrawn'));
