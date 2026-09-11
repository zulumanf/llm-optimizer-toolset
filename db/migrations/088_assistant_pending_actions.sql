-- +migrate up
-- Spec 096: the assistant's human gate, made durable. A confirm-gated tool
-- call mints one row here — bound to the exact tool + input, single-use,
-- expiring — and only the confirm server action (a human click in the
-- operator's session) executes it. The model never sees or supplies the
-- token; it is minted server-side and rendered as a button.

create table assistant_pending_actions (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references assistant_conversations(id),
  user_id uuid not null references users(id),
  tool text not null,
  input jsonb not null default '{}'::jsonb,
  summary text not null,
  token text not null unique,
  status text not null default 'pending'
    check (status in ('pending', 'confirmed', 'cancelled', 'expired')),
  result jsonb,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create index assistant_pending_actions_conversation_idx
  on assistant_pending_actions (conversation_id, created_at desc);

-- +migrate down
drop table assistant_pending_actions;
