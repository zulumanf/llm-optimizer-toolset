-- +migrate up
-- Perplexity enrichment proposals (spec 079). Found ≠ true (spec 027): what
-- the research call returns is staged here with its citations and becomes a
-- platform fact — a contact or an authority signal — ONLY through operator
-- approval. Insert-only rows; a re-run supersedes prior pending proposals;
-- a failed call is stored as a failure row, never a fabricated absence.

create table enrichment_proposals (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid not null references prospects(id),
  kind text not null check (kind in ('contact_email', 'authority_signal')),
  payload jsonb not null default '{}',
  citations jsonb not null default '[]',
  confidence numeric,
  model text not null,
  agent_version text not null,
  status text not null default 'pending' check (status in
    ('pending', 'approved', 'rejected', 'superseded', 'failed')),
  error text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  decided_by uuid references users(id),
  decided_at timestamptz
);

create index enrichment_proposals_prospect_idx
  on enrichment_proposals (prospect_id, status);

-- +migrate down
drop index enrichment_proposals_prospect_idx;
drop table enrichment_proposals;
