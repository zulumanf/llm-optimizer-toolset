-- Spec 129: positive-reply report handoff. One row per positive reply
-- tracks generate → QA → deliver; every QA pass (deterministic or agent)
-- is an insert-only run with the content hash it judged.

-- +migrate up
create table prospect_report_handoffs (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid not null references prospects(id),
  reply_id uuid not null references prospect_replies(id) unique,
  sequence_id uuid references outreach_followup_sequences(id),
  audit_id uuid references prospect_audits(id),
  draft_id uuid references outreach_drafts(id),
  status text not null default 'pending'
    check (status in ('pending', 'report_published', 'qa_passed', 'scheduled', 'sent', 'needs_review', 'stopped')),
  reason text,
  attempts integer not null default 0,
  actor_id uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index prospect_report_handoffs_status_idx on prospect_report_handoffs (status, updated_at);

create table prospect_report_qa_runs (
  id uuid primary key default gen_random_uuid(),
  handoff_id uuid not null references prospect_report_handoffs(id),
  kind text not null check (kind in ('deterministic', 'prospect_review', 'sense_check')),
  content_hash text not null,
  passed boolean not null,
  output jsonb not null default '{}',
  agent_version text,
  model text,
  error text,
  created_at timestamptz not null default now()
);
create index prospect_report_qa_runs_handoff_idx on prospect_report_qa_runs (handoff_id, created_at desc);
create trigger prospect_report_qa_runs_immutable
  before update or delete on prospect_report_qa_runs
  for each row execute function forbid_mutation();

-- +migrate down
drop trigger prospect_report_qa_runs_immutable on prospect_report_qa_runs;
drop table prospect_report_qa_runs;
drop table prospect_report_handoffs;
