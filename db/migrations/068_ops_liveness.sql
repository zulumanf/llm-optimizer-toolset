-- +migrate up
-- Spec 059: the platform can finally tell someone it is dying.

-- Worker liveness. Operational state, deliberately mutable — this is a
-- pulse, not a measurement. The audit's finding: everything asynchronous
-- depends on the worker, and a dead worker was invisible.
create table worker_heartbeats (
  worker_id text primary key,
  last_seen_at timestamptz not null default now(),
  jobs_processed bigint not null default 0,
  started_at timestamptz not null default now()
);

-- Alert dedupe: one webhook post per alert kind per window, then re-arm.
-- Without this the cron heartbeat would repost every firing alert every
-- tick — an alarm that cries constantly is an alarm nobody hears.
create table ops_alerts (
  kind text primary key,
  last_sent_at timestamptz not null default now(),
  last_message text not null default ''
);

-- +migrate down
drop table ops_alerts;
drop table worker_heartbeats;
