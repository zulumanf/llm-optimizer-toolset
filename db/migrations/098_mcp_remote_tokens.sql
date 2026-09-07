-- Spec 126: personal access tokens + call ledger for the remote MCP
-- endpoint (/mcp, Grok connectors). Tokens are sha256-hashed at rest —
-- the secret (rf_live_/rf_test_ + 32 random bytes base64url, ~256 bits)
-- is shown once at mint and never stored. The ledger is insert-only and
-- doubles as the rate-limit window (count of rows per token in the last
-- 60s), which stays correct across multiple web instances.

-- +migrate up
create table mcp_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  name text not null,
  token_hash text not null unique,
  prefix text not null check (prefix in ('rf_live_', 'rf_test_')),
  scopes text[] not null default '{mcp:read}',
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create table mcp_tool_calls (
  id uuid primary key default gen_random_uuid(),
  token_id uuid not null references mcp_tokens(id),
  tool_name text not null,
  -- Entity ids only (team_id, market_id, capture_id…): enough to audit
  -- access, never argument payloads or answer text.
  argument_ids jsonb not null default '{}',
  duration_ms integer,
  error text,
  created_at timestamptz not null default now()
);

create index mcp_tool_calls_rate_idx on mcp_tool_calls (token_id, created_at desc);

create trigger mcp_tool_calls_immutable
  before update or delete on mcp_tool_calls
  for each row execute function forbid_mutation();

-- +migrate down
drop table mcp_tool_calls;
drop table mcp_tokens;
