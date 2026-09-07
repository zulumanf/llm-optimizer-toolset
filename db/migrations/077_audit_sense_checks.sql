-- +migrate up
-- Audit sense-check results (spec 077). Insert-only: each run of the agent
-- is a record of what was checked (content_hash), by which instrument
-- (agent_version, model), and what it found. A failed LLM call is recorded
-- as a failure row (error set, concerns empty) — never fabricated. The
-- publish gate reads the latest row per (prospect, finding) and compares
-- content_hash; a stale or absent check is advisory, never blocking.

create table audit_sense_checks (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid not null references prospects(id),
  finding_id uuid not null references prospect_findings(id),
  content_hash text not null,
  concerns jsonb not null default '[]',
  overall_reads_fair boolean,
  confidence numeric,
  confidence_note text,
  agent_version text not null,
  model text not null,
  error text,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);

create index audit_sense_checks_prospect_finding_idx
  on audit_sense_checks (prospect_id, finding_id, created_at desc);

-- +migrate down
drop index audit_sense_checks_prospect_finding_idx;
drop table audit_sense_checks;
