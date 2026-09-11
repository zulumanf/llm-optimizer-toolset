-- Operating review 2026-09-07: a post-offer rejection is its own reply class
-- ("decline") so price/DIY objections are visible without suppressing anyone.
-- Historical rows are untouched; nothing is reclassified here.
-- +migrate up
alter table prospect_replies drop constraint prospect_replies_classification_check;
alter table prospect_replies add constraint prospect_replies_classification_check check (classification in
  ('positive_interest', 'question', 'objection', 'proof_request',
   'referral', 'not_interested', 'decline', 'unsubscribe', 'out_of_office', 'unclear'));
-- +migrate down
alter table prospect_replies drop constraint prospect_replies_classification_check;
alter table prospect_replies add constraint prospect_replies_classification_check check (classification in
  ('positive_interest', 'question', 'objection', 'proof_request',
   'referral', 'not_interested', 'unsubscribe', 'out_of_office', 'unclear'));
