-- +migrate up
-- Perplexity market-pack drafts (spec 082): a researched pack definition
-- staged for review. Installing is the operator's reviewed act; a draft is
-- never a market until then. Insert-only; failures stored as failed rows.
create table market_pack_drafts (
  id uuid primary key default gen_random_uuid(),
  city_name text not null,
  payload jsonb not null,
  citations jsonb not null default '[]',
  confidence numeric,
  model text not null,
  agent_version text not null,
  status text not null default 'pending' check (status in
    ('pending', 'installed', 'rejected', 'failed')),
  error text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  decided_by uuid references users(id),
  decided_at timestamptz
);
create index market_pack_drafts_status_idx on market_pack_drafts (status);

-- +migrate down
drop index market_pack_drafts_status_idx;
drop table market_pack_drafts;
