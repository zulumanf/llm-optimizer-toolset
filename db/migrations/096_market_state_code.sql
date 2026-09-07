-- +migrate up
-- Spec 124 data pass: a market's USPS state code, so same-named cities in
-- different states (the Wilmington DE/NC lesson, 2026-08-21) can never
-- cross-match licensed RealTrends records. Operator-declared via
-- scripts/ingest-realtrends.ts geo; null = state not asserted, and the
-- dataset matcher then falls back to city-pipeline / signal evidence or
-- skips the market entirely (fail closed).
alter table markets add column state_code text
  check (state_code is null or state_code ~ '^[A-Z]{2}$');

-- +migrate down
alter table markets drop column state_code;
