-- +migrate up
-- Roadmap 2.2: source classification. Citation intelligence can now say
-- WHICH sources influence answers (per-response ledger, 033) — this adds
-- WHAT each source is (portal, news, social…) and WHOSE it is (owned /
-- competitor / third_party), so "which citations should we pursue" has a
-- data answer. Deterministic classifier v1; columns nullable because a
-- source is unclassified until a classifier ran, never defaulted.
alter table sources add column source_type text check (source_type in (
  'client_site', 'brokerage', 'portal', 'news', 'directory', 'social',
  'video', 'review', 'government', 'other'
));
alter table sources add column relationship text check (relationship in (
  'owned', 'competitor', 'third_party'
));
alter table sources add column classifier_version text;
alter table sources add column classified_at timestamptz;

-- +migrate down
alter table sources drop column classified_at;
alter table sources drop column classifier_version;
alter table sources drop column relationship;
alter table sources drop column source_type;
