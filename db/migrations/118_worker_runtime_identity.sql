-- Deployment QA (2026-09-14): the running worker states what it is.
-- RUNNING_COMMIT_MATCHES_EXPECTED and REQUIRED_JOB_HANDLERS_PRESENT are
-- asserted from the heartbeat row, not from the working tree. Additive.

-- +migrate up
alter table worker_heartbeats
  add column if not exists version text,
  add column if not exists handlers text[];

-- +migrate down
alter table worker_heartbeats
  drop column if exists handlers,
  drop column if exists version;
