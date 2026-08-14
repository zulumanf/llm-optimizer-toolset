-- +migrate up
-- Spec 064: gap-finding epistemics. Spec 009 promised confidence and
-- evidence links; migration 009 shipped neither, leaving the client-side
-- diagnosis engine epistemically weaker than the prospect-side one.
-- All nullable/defaulted: legacy detector-v1 rows stay honestly unlabeled —
-- no backfill invents confidence that was never computed.
alter table gap_findings add column confidence numeric
  check (confidence is null or (confidence >= 0 and confidence <= 1));
alter table gap_findings add column classification text
  check (classification is null or classification in
    ('observation', 'supported_finding', 'working_hypothesis', 'unknown'));
alter table gap_findings add column evidence_ids uuid[] not null default '{}';
-- Promotion link (traceability): status = 'task_created' said THAT a task
-- exists but not WHICH — the chain evidence → finding → task was unwalkable.
alter table gap_findings add column task_id uuid references tasks(id);

-- +migrate down
alter table gap_findings drop column task_id;
alter table gap_findings drop column evidence_ids;
alter table gap_findings drop column classification;
alter table gap_findings drop column confidence;
