-- Spec 135: pricing policy. Quotes are commercial events — which policy was
-- active when a price was stated to whom, and what came back. Engagements
-- carry the policy they were signed under and any founder override. Policies
-- themselves live in code (lib/pricing/policy.ts), versioned in git; rows
-- reference them by version string. Historical quotes are backfilled from
-- the sent drafts that carried the v0 offer wording and never rewritten.

-- +migrate up
create table pricing_quotes (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid not null references prospects(id),
  company_id uuid references companies(id),
  market_id uuid references markets(id),
  engagement_id uuid references client_engagements(id),
  pricing_policy_version text not null,
  offer_name text not null,
  total_fee_usd numeric not null check (total_fee_usd >= 0),
  term_days int not null check (term_days > 0),
  billing_structure jsonb not null default '{}',
  quoted_at timestamptz not null default now(),
  channel text not null default 'email',
  draft_id uuid references outreach_drafts(id),
  send_id uuid references prospect_outreach_sends(id),
  status text not null default 'presented'
    check (status in ('presented', 'accepted', 'declined', 'withdrawn')),
  responded_at timestamptz,
  response_summary text,
  objections text[] not null default '{}',
  preferred_solution text
    check (preferred_solution is null or preferred_solution in ('DONE_FOR_YOU', 'DONE_WITH_YOU', 'DIY')),
  outcome text not null default 'open' check (outcome in ('open', 'client_won', 'lost')),
  lost_reason text,
  default_total_fee_usd numeric,
  override_reason text,
  recorded_by uuid references users(id),
  outcome_recorded_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index pricing_quotes_prospect_idx on pricing_quotes (prospect_id, quoted_at desc);
create unique index pricing_quotes_send_unique on pricing_quotes (send_id) where send_id is not null;

alter table client_engagements add column pricing_policy_version text;
alter table client_engagements add column default_total_value_usd numeric;
alter table client_engagements add column price_override_reason text;

-- Backfill: every allowed send whose body stated the v0 offer ("$7,500/month")
-- to a prospect is a presented quote under founder_monthly_7500_v0. Outcomes
-- are recorded by the founder afterwards, never inferred here.
insert into pricing_quotes
  (prospect_id, company_id, market_id, pricing_policy_version, offer_name, total_fee_usd, term_days,
   billing_structure, quoted_at, channel, draft_id, send_id, status, recorded_by)
select p.id, p.company_id, l.market_id, 'founder_monthly_7500_v0', 'Initial 90-day engagement', 22500, 90,
  '{"installments": 3, "installmentUsd": 7500, "schedule": ["month 1", "month 2", "month 3"]}'::jsonb,
  s.sent_at, s.channel, d.id, s.id, 'presented', s.sent_by
from prospect_outreach_sends s
join outreach_drafts d on d.id = s.draft_id
join prospects p on p.id = s.prospect_id
join market_launches l on l.id = p.launch_id
where s.allowed and d.body like '%$7,500/month%';

-- +migrate down
alter table client_engagements drop column price_override_reason;
alter table client_engagements drop column default_total_value_usd;
alter table client_engagements drop column pricing_policy_version;
drop index pricing_quotes_send_unique;
drop index pricing_quotes_prospect_idx;
drop table pricing_quotes;
