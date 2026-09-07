-- +migrate up
-- Spec 114: one durable standing-preferences block per operator, rendered
-- into the assistant's system prompt. Updates overwrite; the audit log is
-- the history.
create table assistant_preferences (
  user_id uuid primary key references users(id),
  content text not null check (char_length(content) <= 2000),
  updated_at timestamptz not null default now()
);

-- +migrate down
drop table assistant_preferences;
