-- +migrate up
-- Spec 081: enrichment proposals gain the buying_signal kind — Perplexity-
-- found recent developments (brokerage moves, expansions, media activity)
-- staged for operator approval into the existing buying-signals machinery.
alter table enrichment_proposals drop constraint enrichment_proposals_kind_check;
alter table enrichment_proposals add constraint enrichment_proposals_kind_check
  check (kind in ('contact_email', 'authority_signal', 'buying_signal'));

-- +migrate down
alter table enrichment_proposals drop constraint enrichment_proposals_kind_check;
alter table enrichment_proposals add constraint enrichment_proposals_kind_check
  check (kind in ('contact_email', 'authority_signal'));
