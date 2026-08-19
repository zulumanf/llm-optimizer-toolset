-- +migrate up
-- Evidence quality hardening (Team Moza audit review, 2026-08-19).
--
-- 1. 'sponsored' joins the authority-signal evidence classification.
--    Sponsored publication coverage (e.g. a paid Jersey Digs feature) is
--    useful evidence but must never carry the epistemic weight of
--    independent reporting or a verified ranking — the label makes the
--    distinction storable; lib/prospects/authority.ts discounts it.
alter table prospect_authority_signals
  drop constraint prospect_authority_signals_source_type_check;
alter table prospect_authority_signals
  add constraint prospect_authority_signals_source_type_check
    check (source_type in ('independent', 'self_reported', 'derived', 'sponsored'));

-- 2. Evidence-link health ledger. The RealTrends receipt on a live audit
--    went stale with nothing watching it — an evidence-first product cannot
--    silently render a dead receipt as healthy. Append-only, like
--    source_presence_checks (069): a later check is a NEW row, the latest
--    row per URL wins on read. 'superseded' is reserved for a manual
--    canonical replacement; the sweep writes the other four states.
create table evidence_link_checks (
  id uuid primary key default gen_random_uuid(),
  url text not null,
  final_url text,
  http_status int,
  state text not null check (state in
    ('healthy', 'redirected', 'broken', 'unavailable', 'superseded')),
  error text,
  checked_at timestamptz not null default now()
);
create index evidence_link_checks_url_idx
  on evidence_link_checks (url, checked_at desc);
create trigger evidence_link_checks_immutable
  before update or delete on evidence_link_checks
  for each row execute function forbid_mutation();

-- +migrate down
drop table evidence_link_checks;
-- Rows classified 'sponsored' return to unclassified (never silently
-- remapped to a classification they are not — the 081 precedent).
update prospect_authority_signals set source_type = null
  where source_type = 'sponsored';
alter table prospect_authority_signals
  drop constraint prospect_authority_signals_source_type_check;
alter table prospect_authority_signals
  add constraint prospect_authority_signals_source_type_check
    check (source_type in ('independent', 'self_reported', 'derived'));
