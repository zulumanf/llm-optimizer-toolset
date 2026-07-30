-- Spec 026 follow-up: plan items carry the steps, not just the reasoning.
--
-- The first cut stored a rationale paragraph per play. It explained why the
-- play mattered and left the operator to work out what to actually do — which
-- is the half a plan exists to provide. Steps are stored as an ordered array so
-- the UI can render them as a checklist rather than prose.

-- +migrate up
alter table plan_items
  add column steps text[] not null default '{}';

-- +migrate down
alter table plan_items drop column steps;
