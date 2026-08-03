-- +migrate up
-- Spec 038: authority signals gain a market scope and a retrieval date.
-- Global-scope evidence (nationwide volume, brand-level rankings) is real but
-- must not automatically count as LOCAL authority — the authority profile
-- excludes it with a reason instead of silently discounting it. Default
-- 'local' matches every existing row's intent: signals are recorded against
-- a prospect inside a market launch.

alter table prospect_authority_signals
  add column scope text not null default 'local'
    check (scope in ('local', 'global')),
  add column retrieved_at timestamptz;

-- +migrate down
alter table prospect_authority_signals
  drop column retrieved_at,
  drop column scope;
