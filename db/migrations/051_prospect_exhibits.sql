-- +migrate up
-- Spec 045 Tier 2: live example chats — share links from the CONSUMER
-- assistants (chatgpt.com/share, perplexity.ai), created manually by an
-- operator and attached as exhibits. They are corroborating demos hosted on
-- a third party's domain, never measurements: the sampled API benchmark
-- stays the evidence; these are what it looks like live.

create table prospect_exhibits (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid not null references prospects(id),
  url text not null,
  assistant text not null check (assistant in ('chatgpt', 'perplexity')),
  question text not null,
  captured_on date not null,
  notes text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  archived_at timestamptz
);
create index prospect_exhibits_prospect_idx
  on prospect_exhibits (prospect_id) where archived_at is null;

-- +migrate down
drop table prospect_exhibits;
