-- Notifications (docs/17 B2): the shared primitive Reputation Accuracy
-- alerts, approval queues, and report delivery all depend on.

-- +migrate up
create table notifications (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id),
  kind text not null,
  severity text not null check (severity in ('urgent', 'attention', 'info')),
  title text not null,
  body text not null,
  href text,
  -- One row per distinct ongoing issue, not one per scan: a re-sync updates
  -- the existing row instead of stacking duplicates.
  dedupe_key text not null unique,
  status text not null default 'unread'
    check (status in ('unread', 'read', 'resolved', 'dismissed')),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  read_at timestamptz,
  resolved_at timestamptz
);

create index notifications_status_idx on notifications (status, severity);
create index notifications_project_idx on notifications (project_id);

-- +migrate down
drop table notifications;
