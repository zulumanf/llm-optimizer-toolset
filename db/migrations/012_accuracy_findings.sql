-- Spec 015: factual-accuracy findings — what AI gets wrong about the client

-- +migrate up
create table accuracy_findings (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id),
  run_id uuid not null references runs(id),
  response_id uuid not null references responses(id),
  kind text not null check (kind in (
    'entity_confusion', 'contradicted', 'outdated', 'unverifiable',
    'missing_context'
  )),
  -- Verbatim span from the immutable response (deterministic quote gate)
  quote text not null,
  claim_id uuid references claims(id),
  rationale text not null,
  severity text not null check (severity in ('high', 'medium', 'low')),
  confidence numeric not null,
  agent_version text not null,
  status text not null default 'open'
    check (status in ('open', 'acknowledged', 'dismissed', 'corrected')),
  task_id uuid references tasks(id),
  created_at timestamptz not null default now()
);

create index accuracy_findings_project_idx
  on accuracy_findings (project_id, status, severity);
create index accuracy_findings_response_idx on accuracy_findings (response_id);
-- Re-analysis must not duplicate findings
create unique index accuracy_findings_dedup
  on accuracy_findings (response_id, kind, md5(quote));

-- +migrate down
drop table accuracy_findings;
