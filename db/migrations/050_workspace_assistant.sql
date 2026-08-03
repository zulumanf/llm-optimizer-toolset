-- +migrate up
-- Spec 044: the workspace assistant's conversation record. Messages are
-- insert-only — a chat transcript whose every data lookup is recorded is
-- evidence of what the operator was told, and evidence does not get edited.

create table assistant_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  title text,
  started_at timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  archived_at timestamptz
);
create index assistant_conversations_user_idx
  on assistant_conversations (user_id, last_message_at desc) where archived_at is null;

create table assistant_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references assistant_conversations(id),
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  -- [{tool, input, ok, summary}] — every lookup the reply rests on
  -- (camelCase keys inside: postgres.camel rewrites snake JSONB keys on read).
  tool_calls jsonb not null default '[]',
  cost_micro_usd int,
  created_at timestamptz not null default now()
);
create index assistant_messages_conversation_idx
  on assistant_messages (conversation_id, created_at asc);

create trigger assistant_messages_immutable
  before update or delete on assistant_messages
  for each row execute function forbid_mutation();

-- +migrate down
drop table assistant_messages;
drop table assistant_conversations;
