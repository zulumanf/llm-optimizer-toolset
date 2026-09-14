-- Spec 141 follow-up: explicit verification status on mention revisions.
-- Mentions are insert-only (mentions_immutable trigger), so these columns are
-- populated only on NEW revision rows (revision 3 adjudication and later);
-- legacy rows keep null and their status is DERIVED by the documented rule in
-- lib/parsing/precedence.ts (LLM row with confidence >= 0.7 and no review
-- flag = verified; heuristic row = directional; review-flagged = manual).
-- Additive, idempotent, no existing row is read or rewritten.

-- +migrate up
alter table mentions
  add column if not exists classification_method text,
  add column if not exists classification_reason text,
  add column if not exists verification_status text
    check (verification_status in ('verified', 'directional', 'needs_manual_review', 'not_classified'));
create index if not exists mentions_verification_status_idx on mentions (verification_status) where verification_status is not null;

-- +migrate down
drop index if exists mentions_verification_status_idx;
alter table mentions
  drop column if exists verification_status,
  drop column if exists classification_reason,
  drop column if exists classification_method;
