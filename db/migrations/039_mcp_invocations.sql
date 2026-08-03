-- Spec 033: append-only ledger of MCP tool invocations that mutate state.
-- Read tools are pure delegations and are not recorded (they would bloat the
-- ledger without adding evidence). One row per executed mutation attempt,
-- success or failure; the partial unique index gives keyed calls replay
-- semantics — a repeated key after a successful execution returns the
-- recorded entity instead of executing again. A failed attempt does not
-- consume its key, so retrying after a validation error works.

-- +migrate up
create table mcp_invocations (
  id uuid primary key default gen_random_uuid(),
  tool text not null,
  actor_id uuid not null references users(id),
  args_hash text not null,
  idempotency_key text,
  outcome text not null check (outcome in ('ok', 'error')),
  entity_kind text,
  entity_id uuid,
  error text,
  created_at timestamptz not null default now()
);

create unique index mcp_invocations_idempotency_unique
  on mcp_invocations (tool, idempotency_key)
  where idempotency_key is not null and outcome = 'ok';

create index mcp_invocations_created_idx on mcp_invocations (created_at);

create trigger mcp_invocations_immutable
  before update or delete on mcp_invocations
  for each row execute function forbid_mutation();

-- +migrate down
drop table mcp_invocations;
