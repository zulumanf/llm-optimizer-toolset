-- +migrate up
-- Scores are append-only measurements (docs/03, docs/06): a new scoring
-- version writes new rows and historical values never change. Every peer
-- measurement table (responses, mentions, prompt_set_versions,
-- evidence_artifacts) already enforces that with forbid_mutation();
-- scores relied on convention alone (production-readiness plan 2.4).
-- Reuses forbid_mutation() from migration 001.
create trigger scores_immutable
  before update or delete on scores
  for each row execute function forbid_mutation();

-- +migrate down
drop trigger scores_immutable on scores;
