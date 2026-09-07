-- +migrate up
-- RealTrends authority upgrade (2026-08-15): authority signals gain an
-- explicit evidence classification and a structured payload.
--
-- source_type answers "who stands behind this fact":
--   independent   — third party attests it (RealTrends rankings, trade press)
--   self_reported — the subject or their brokerage published it about themselves
--   derived       — deterministic arithmetic over other signals (never scored;
--                   see lib/prospects/authority.ts exclusion rule)
-- Nullable: legacy rows predate the classification and render with the
-- neutral copy path; they are never silently promoted to "independent".
--
-- metadata carries the structured record behind a signal (for RealTrends:
-- rank, rank_scope, scope_comparable, volume_usd, sides, entity_type, city,
-- state, brokerage, production_year, publication_year, page_title,
-- record_type). rank_scope is MANDATORY for RealTrends ranking rows — a
-- category-specific #1 must never render as an overall-market #1.

alter table prospect_authority_signals
  add column source_type text
    check (source_type in ('independent', 'self_reported', 'derived')),
  add column metadata jsonb;

create index prospect_authority_signals_record_type_idx
  on prospect_authority_signals ((metadata->>'record_type'))
  where metadata is not null;

-- +migrate down
drop index prospect_authority_signals_record_type_idx;
alter table prospect_authority_signals
  drop column metadata,
  drop column source_type;
