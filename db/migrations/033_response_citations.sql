-- +migrate up
-- Roadmap 1.3: per-response citation ledger. Until now citation intelligence
-- was a running counter on `sources` — "this URL was cited N times" with no
-- way back to WHICH responses cited it. The ledger is the join the counter
-- threw away: every (response, url) pair, split by how the URL arrived
-- (in the answer text vs the provider's search retrieval).
--
-- Immutable because it is derived deterministically from immutable payloads
-- (extractUrls on response_text ∪ extractCitations on raw_payload) — a
-- re-parse re-derives identical rows, absorbed by ON CONFLICT DO NOTHING.

create table response_citations (
  id uuid primary key default gen_random_uuid(),
  response_id uuid not null references responses(id),
  url text not null,
  domain text not null,
  kind text not null check (kind in ('in_text', 'search')),
  -- owner by domain suffix against the run's project-scoped companies,
  -- resolved at parse time; null = third-party or unattributed
  company_id uuid references companies(id),
  created_at timestamptz not null default now(),
  unique (response_id, url, kind)
);

create trigger response_citations_immutable
  before update or delete on response_citations
  for each row execute function forbid_mutation();

create index response_citations_response_idx on response_citations (response_id);
create index response_citations_domain_idx on response_citations (domain);

-- +migrate down
drop table response_citations;
