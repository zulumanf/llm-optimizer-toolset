-- +migrate up
-- Spec 042: buying signals — evidence of purchase intent/timing, distinct
-- from authority signals (evidence of market standing). The target rule is
-- hard: every buying signal requires a source URL and an observed date;
-- both are NOT NULL here, not just service-validated.

create table prospect_buying_signals (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid not null references prospects(id),
  kind text not null check (kind in (
    'brokerage_move', 'team_expansion', 'hiring_marketing', 'website_redesign',
    'new_market_launch', 'new_development_listings', 'media_activity',
    'new_leadership', 'paid_marketing_active', 'seo_pr_investment', 'other'
  )),
  label text not null,
  source_url text not null,
  observed_on date not null,
  provenance text not null check (provenance in
    ('verified', 'publicly_sourced', 'estimated', 'manual', 'ai_inferred')),
  confidence numeric check (confidence is null or (confidence >= 0 and confidence <= 1)),
  notes text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  archived_at timestamptz
);
create index prospect_buying_signals_prospect_idx
  on prospect_buying_signals (prospect_id) where archived_at is null;

-- +migrate down
drop table prospect_buying_signals;
