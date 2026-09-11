-- Spec 138 (migration 113; numbered above main's 112 at merge time): personalized video walkthrough on the spec 137 foundation. The
-- generic artifact ledger learns a video sub-stage, an idempotent
-- generation key and a typed metadata blob (versions, narration, render,
-- QA, distribution, timestamps); the QA ledger learns the three video
-- verdict kinds. The canonical MP4 and captions are evidence_artifacts rows
-- (kind video / export_file, migration 011). No table is created; nothing
-- historical is mutated.

-- +migrate up
alter table prospect_fulfillment_artifacts
  add column stage text,
  add column generation_key text,
  add column meta jsonb not null default '{}'::jsonb;
create unique index prospect_fulfillment_artifacts_generation_key_idx
  on prospect_fulfillment_artifacts (handoff_id, kind, generation_key) where generation_key is not null;
create index prospect_fulfillment_artifacts_stage_idx
  on prospect_fulfillment_artifacts (kind, stage) where stage is not null;

alter table prospect_report_qa_runs drop constraint prospect_report_qa_runs_kind_check;
alter table prospect_report_qa_runs add constraint prospect_report_qa_runs_kind_check
  check (kind in (
    'deterministic', 'prospect_review', 'sense_check', 'release_gate', 'manifest_assertion', 'release_review',
    'video_script_qa', 'video_semantic_review', 'video_artifact_qa'
  ));

-- +migrate down
-- Rolling back removes the video QA verdict kinds (the one destructive
-- direction; the ledger trigger is lifted for exactly that statement).
drop trigger prospect_report_qa_runs_immutable on prospect_report_qa_runs;
delete from prospect_report_qa_runs where kind in ('video_script_qa', 'video_semantic_review', 'video_artifact_qa');
create trigger prospect_report_qa_runs_immutable
  before update or delete on prospect_report_qa_runs
  for each row execute function forbid_mutation();
alter table prospect_report_qa_runs drop constraint prospect_report_qa_runs_kind_check;
alter table prospect_report_qa_runs add constraint prospect_report_qa_runs_kind_check
  check (kind in ('deterministic', 'prospect_review', 'sense_check', 'release_gate', 'manifest_assertion', 'release_review'));
drop index prospect_fulfillment_artifacts_stage_idx;
drop index prospect_fulfillment_artifacts_generation_key_idx;
alter table prospect_fulfillment_artifacts drop column meta, drop column generation_key, drop column stage;
