-- Spec 137: autonomous, evidence-locked fulfillment lane for low-ambiguity
-- positive replies. Extends the spec 129 handoff (the workflow instance)
-- with explicit lane states, the autonomy classification, the canonical
-- fact manifest every artifact consumes, an artifact ledger, and a durable
-- send intent on the scheduled draft (the existing outbox) so a crash
-- between Gmail acceptance and ledger persistence reconciles instead of
-- resending. Nothing historical is mutated; every new column is nullable
-- or defaulted.

-- +migrate up
alter table prospect_report_handoffs drop constraint prospect_report_handoffs_status_check;
alter table prospect_report_handoffs add constraint prospect_report_handoffs_status_check
  check (status in (
    'pending', 'autonomy_eligible', 'evidence_verified', 'report_published', 'qa_passed',
    'release_ready', 'scheduled', 'sent', 'needs_review', 'stopped'
  ));
alter table prospect_report_handoffs
  add column lane_mode text,
  add column autonomy_class text check (autonomy_class in ('autonomy_eligible', 'escalate')),
  add column autonomy_reason text,
  add column auto_verdict text check (auto_verdict in ('would_send', 'transmit', 'escalated', 'held', 'blocked')),
  add column manifest_id uuid,
  add column release_verdict jsonb,
  add column claimed_at timestamptz,
  add column reactivated_at timestamptz,
  add column reactivated_by uuid references users(id);

-- One immutable fact manifest per verified evidence state. Hash-keyed so a
-- re-run over unchanged evidence reuses the row; a changed evidence state
-- (correction, recount) produces a new hash and a new row.
create table prospect_fact_manifests (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid not null references prospects(id),
  handoff_id uuid references prospect_report_handoffs(id),
  version text not null,
  evidence_hash text not null,
  manifest_hash text not null,
  manifest jsonb not null,
  created_at timestamptz not null default now(),
  unique (prospect_id, manifest_hash)
);
create index prospect_fact_manifests_handoff_idx on prospect_fact_manifests (handoff_id, created_at desc);
create trigger prospect_fact_manifests_immutable
  before update or delete on prospect_fact_manifests
  for each row execute function forbid_mutation();
alter table prospect_report_handoffs
  add constraint prospect_report_handoffs_manifest_fk foreign key (manifest_id) references prospect_fact_manifests(id);

-- Generic customer-facing artifact ledger: report, email, video script,
-- video walkthrough, evidence summary. Each revision references the
-- manifest it was compiled from; a stale revision is marked, never edited.
create table prospect_fulfillment_artifacts (
  id uuid primary key default gen_random_uuid(),
  handoff_id uuid not null references prospect_report_handoffs(id),
  prospect_id uuid not null references prospects(id),
  kind text not null check (kind in ('private_report', 'positive_reply_email', 'video_script', 'video_walkthrough', 'evidence_summary')),
  revision integer not null,
  manifest_id uuid not null references prospect_fact_manifests(id),
  template_version text not null,
  ref_audit_id uuid references prospect_audits(id),
  ref_draft_id uuid references outreach_drafts(id),
  content_hash text not null,
  status text not null default 'prepared' check (status in ('prepared', 'ready', 'stale', 'sent', 'superseded')),
  stale_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (handoff_id, kind, revision)
);
create index prospect_fulfillment_artifacts_handoff_idx on prospect_fulfillment_artifacts (handoff_id, kind, revision desc);

-- QA ledger learns the two deterministic lane verdicts.
alter table prospect_report_qa_runs drop constraint prospect_report_qa_runs_kind_check;
alter table prospect_report_qa_runs add constraint prospect_report_qa_runs_kind_check
  check (kind in ('deterministic', 'prospect_review', 'sense_check', 'release_gate', 'manifest_assertion', 'release_review'));

-- Durable send intent on the outbox row: one logical external action has
-- one idempotency identity (unique), and the RFC Message-ID we stamp on
-- the outgoing mail is the fingerprint reconciliation searches for.
alter table outreach_drafts
  add column send_intent_key text,
  add column send_message_id text;
create unique index outreach_drafts_send_intent_key_idx on outreach_drafts (send_intent_key) where send_intent_key is not null;

-- A ledger row written by reconciliation (message found in the mailbox
-- after a lost acknowledgement) says so; the ledger stays insert-only.
alter table prospect_outreach_sends add column reconciled_from text;

-- +migrate down
alter table prospect_outreach_sends drop column reconciled_from;
drop index outreach_drafts_send_intent_key_idx;
alter table outreach_drafts drop column send_message_id, drop column send_intent_key;
-- Rolling back removes the lane's QA verdict kinds (rollback is the one
-- destructive direction; the ledger trigger is lifted for exactly that).
drop trigger prospect_report_qa_runs_immutable on prospect_report_qa_runs;
delete from prospect_report_qa_runs where kind in ('release_gate', 'manifest_assertion', 'release_review');
create trigger prospect_report_qa_runs_immutable
  before update or delete on prospect_report_qa_runs
  for each row execute function forbid_mutation();
alter table prospect_report_qa_runs drop constraint prospect_report_qa_runs_kind_check;
alter table prospect_report_qa_runs add constraint prospect_report_qa_runs_kind_check
  check (kind in ('deterministic', 'prospect_review', 'sense_check'));
drop table prospect_fulfillment_artifacts;
alter table prospect_report_handoffs drop constraint prospect_report_handoffs_manifest_fk;
drop trigger prospect_fact_manifests_immutable on prospect_fact_manifests;
drop table prospect_fact_manifests;
alter table prospect_report_handoffs
  drop column reactivated_by, drop column reactivated_at, drop column claimed_at,
  drop column release_verdict, drop column manifest_id, drop column auto_verdict,
  drop column autonomy_reason, drop column autonomy_class, drop column lane_mode;
update prospect_report_handoffs set status = 'pending' where status in ('autonomy_eligible', 'evidence_verified');
update prospect_report_handoffs set status = 'qa_passed' where status = 'release_ready';
alter table prospect_report_handoffs drop constraint prospect_report_handoffs_status_check;
alter table prospect_report_handoffs add constraint prospect_report_handoffs_status_check
  check (status in ('pending', 'report_published', 'qa_passed', 'scheduled', 'sent', 'needs_review', 'stopped'));
