-- Spec 018: the workflow graph — versioned directed graphs as the unit of work.
--
-- Design notes that the column list alone does not carry:
--  * workflow_versions is the immutable artifact. A changed graph is a new
--    version; a completed run stays reproducible because it points at the
--    version it ran, not at the definition.
--  * node_runs is keyed by (run, node, fan_key). That index IS the idempotency
--    guarantee for fan-out and for retries — a retry cannot create a second
--    instance of work that already settled.
--  * workflow_transitions and workflow_approvals decisions are append-only.
--    "Who decided what, when, and why" is evidence (PRINCIPLES #3).

-- +migrate up

-- ---------------------------------------------------------------- definitions
create table workflow_definitions (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  name text not null,
  description text not null default '',
  -- Autonomy level 0-4 (docs/architecture/automation-quality-operating-model)
  autonomy_level smallint not null default 2
    check (autonomy_level between 0 and 4),
  action_type text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table workflow_versions (
  id uuid primary key default gen_random_uuid(),
  definition_id uuid not null references workflow_definitions(id),
  version integer not null,
  -- sha256 of the canonicalised graph; re-registering an identical graph is a
  -- no-op rather than a version bump
  graph_hash text not null,
  spec jsonb not null,
  status text not null default 'published'
    check (status in ('draft', 'published', 'deprecated')),
  published_at timestamptz not null default now(),
  created_by uuid
);
create unique index workflow_versions_unique on workflow_versions (definition_id, version);
create unique index workflow_versions_hash on workflow_versions (definition_id, graph_hash);
create trigger workflow_versions_immutable
  before update or delete on workflow_versions
  for each row execute function forbid_mutation();

create table workflow_nodes (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references workflow_versions(id),
  node_key text not null,
  node_type text not null check (node_type in (
    'deterministic_task', 'agent_task', 'integration_task', 'verification_task',
    'approval_gate', 'evidence_gate', 'condition', 'fan_out', 'fan_in',
    'delay', 'timer', 'notification', 'manual_task',
    'terminal_success', 'terminal_failure'
  )),
  name text not null,
  description text not null default '',
  input_schema jsonb,
  output_schema jsonb,
  handler text,
  agent_version text,
  allowed_tools text[] not null default '{}',
  required_evidence text[] not null default '{}',
  confidence_threshold numeric(4,3),
  timeout_seconds integer not null default 900,
  max_attempts smallint not null default 3,
  retry_backoff_seconds integer not null default 30,
  risk_level text not null default 'low'
    check (risk_level in ('low', 'medium', 'high', 'critical')),
  requires_approval boolean not null default false,
  approval_role text check (approval_role in ('operator', 'admin')),
  idempotency_strategy text not null default 'fan_key'
    check (idempotency_strategy in ('fan_key', 'natural_key', 'none')),
  failure_strategy text not null default 'fail_workflow'
    check (failure_strategy in ('fail_workflow', 'safe_stop', 'continue', 'escalate')),
  autonomy_level smallint check (autonomy_level between 0 and 4),
  config jsonb not null default '{}'::jsonb
);
create unique index workflow_nodes_key on workflow_nodes (version_id, node_key);
create trigger workflow_nodes_immutable
  before update or delete on workflow_nodes
  for each row execute function forbid_mutation();

create table workflow_edges (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references workflow_versions(id),
  from_node_key text not null,
  to_node_key text not null,
  -- Named, deterministic condition evaluated against the source node's output
  condition jsonb,
  priority smallint not null default 100,
  required boolean not null default true,
  on_failure text not null default 'block'
    check (on_failure in ('block', 'skip', 'route')),
  -- Non-null only for a declared bounded rework loop (cycle detection allows it)
  loop_max_iterations smallint
);
create unique index workflow_edges_unique
  on workflow_edges (version_id, from_node_key, to_node_key);
create index workflow_edges_from_idx on workflow_edges (version_id, from_node_key);
create trigger workflow_edges_immutable
  before update or delete on workflow_edges
  for each row execute function forbid_mutation();

-- ----------------------------------------------------------------- execution
create table workflow_runs (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references workflow_versions(id),
  -- Tenant key. Project = client engagement (docs/15).
  project_id uuid references projects(id),
  trigger text not null default 'manual'
    check (trigger in ('manual', 'scheduled', 'signal', 'chained')),
  -- Duplicate starts collapse onto the first run
  idempotency_key text not null unique,
  state text not null default 'queued' check (state in (
    'queued', 'initializing', 'running', 'waiting_for_dependency',
    'waiting_for_approval', 'waiting_for_external_system',
    'partially_completed', 'completed', 'failed', 'cancelled',
    'safely_stopped', 'timed_out'
  )),
  input jsonb not null default '{}'::jsonb,
  output jsonb,
  stop_reason text,
  cost_cap_micro_usd bigint,
  cost_micro_usd bigint not null default 0,
  max_parallel smallint not null default 8,
  deadline_at timestamptz,
  started_by uuid,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);
create index workflow_runs_state_idx on workflow_runs (state);
create index workflow_runs_project_idx on workflow_runs (project_id, started_at desc);

create table node_runs (
  id uuid primary key default gen_random_uuid(),
  workflow_run_id uuid not null references workflow_runs(id),
  node_id uuid not null references workflow_nodes(id),
  node_key text not null,
  -- '' for a singleton node; the fan-out item key otherwise
  fan_key text not null default '',
  state text not null default 'pending' check (state in (
    'pending', 'ready', 'running', 'succeeded', 'failed_retryable',
    'failed_terminal', 'awaiting_verification', 'awaiting_approval',
    'skipped', 'cancelled', 'timed_out'
  )),
  attempts smallint not null default 0,
  input jsonb,
  output jsonb,
  confidence numeric(4,3),
  cost_micro_usd bigint not null default 0,
  error text,
  -- Set when a human (not the engine) moved this node
  human_touch boolean not null default false,
  ready_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  next_attempt_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index node_runs_instance
  on node_runs (workflow_run_id, node_key, fan_key);
create index node_runs_run_idx on node_runs (workflow_run_id, state);

create table workflow_transitions (
  id bigserial primary key,
  workflow_run_id uuid not null references workflow_runs(id),
  node_run_id uuid references node_runs(id),
  scope text not null check (scope in ('workflow', 'node')),
  from_state text,
  to_state text not null,
  actor text not null,
  actor_user_id uuid,
  reason text not null default '',
  workflow_version integer not null,
  node_version text,
  input_version text,
  output_version text,
  at timestamptz not null default now()
);
create index workflow_transitions_run_idx on workflow_transitions (workflow_run_id, at);
create trigger workflow_transitions_immutable
  before update or delete on workflow_transitions
  for each row execute function forbid_mutation();

create table workflow_signals (
  id uuid primary key default gen_random_uuid(),
  workflow_run_id uuid not null references workflow_runs(id),
  node_run_id uuid references node_runs(id),
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  sent_by uuid,
  sent_at timestamptz not null default now(),
  consumed_at timestamptz
);
create index workflow_signals_pending_idx
  on workflow_signals (workflow_run_id) where consumed_at is null;

create table workflow_approvals (
  id uuid primary key default gen_random_uuid(),
  workflow_run_id uuid not null references workflow_runs(id),
  node_run_id uuid not null references node_runs(id),
  project_id uuid references projects(id),
  action_type text not null,
  risk_level text not null,
  required_role text not null default 'operator'
    check (required_role in ('operator', 'admin')),
  summary text not null,
  detail jsonb not null default '{}'::jsonb,
  evidence_ids uuid[] not null default '{}',
  decision text check (decision in ('approved', 'rejected', 'deferred')),
  decided_by uuid,
  decided_at timestamptz,
  rationale text,
  due_at timestamptz,
  requested_at timestamptz not null default now()
);
create index workflow_approvals_pending_idx
  on workflow_approvals (project_id, requested_at) where decision is null;
create unique index workflow_approvals_one_per_node on workflow_approvals (node_run_id);

-- ------------------------------------------------------- exceptions & gates
create table workflow_exceptions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id),
  workflow_run_id uuid references workflow_runs(id),
  node_run_id uuid references node_runs(id),
  kind text not null,
  severity text not null default 'medium'
    check (severity in ('low', 'medium', 'high', 'critical')),
  summary text not null,
  detail jsonb not null default '{}'::jsonb,
  evidence_ids uuid[] not null default '{}',
  recommended_action text not null default '',
  owner uuid,
  escalation_path text not null default 'operator',
  sla_hours integer,
  due_at timestamptz,
  status text not null default 'open'
    check (status in ('open', 'acknowledged', 'resolved', 'dismissed')),
  resolution text,
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create index workflow_exceptions_open_idx
  on workflow_exceptions (status, severity) where status in ('open', 'acknowledged');
create index workflow_exceptions_project_idx on workflow_exceptions (project_id, created_at desc);
-- One open exception per (run, node, kind): a retrying tick must not spam
create unique index workflow_exceptions_dedup
  on workflow_exceptions (coalesce(node_run_id, '00000000-0000-0000-0000-000000000000'::uuid), kind)
  where status in ('open', 'acknowledged');

create table quality_gate_results (
  id uuid primary key default gen_random_uuid(),
  workflow_run_id uuid not null references workflow_runs(id),
  node_run_id uuid references node_runs(id),
  gate_type text not null,
  gate_version text not null,
  outcome text not null check (outcome in ('pass', 'fail', 'insufficient_evidence')),
  checks jsonb not null,
  evaluated_at timestamptz not null default now()
);
create index quality_gate_results_run_idx on quality_gate_results (workflow_run_id);
create trigger quality_gate_results_immutable
  before update or delete on quality_gate_results
  for each row execute function forbid_mutation();

-- ------------------------------------------------------------ agent registry
create table agent_definitions (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  name text not null,
  mission text not null,
  -- Which of the five products this agent serves; drives registry grouping
  domain text not null,
  status text not null default 'active'
    check (status in ('active', 'deprecated')),
  created_at timestamptz not null default now(),
  deprecated_at timestamptz
);

create table agent_versions (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agent_definitions(id),
  version text not null,
  model text not null,
  input_schema jsonb not null,
  output_schema jsonb not null,
  allowed_tools text[] not null default '{}',
  allowed_data_scopes text[] not null default '{}',
  prohibited_actions text[] not null default '{}',
  evidence_requirements text[] not null default '{}',
  min_confidence numeric(4,3),
  escalation_conditions text[] not null default '{}',
  max_cost_micro_usd bigint,
  max_seconds integer,
  evaluation_suite text,
  created_at timestamptz not null default now()
);
create unique index agent_versions_unique on agent_versions (agent_id, version);
create trigger agent_versions_immutable
  before update or delete on agent_versions
  for each row execute function forbid_mutation();

create table agent_evaluations (
  id uuid primary key default gen_random_uuid(),
  agent_version_id uuid not null references agent_versions(id),
  suite text not null,
  passed integer not null,
  total integer not null,
  detail jsonb not null default '{}'::jsonb,
  evaluated_at timestamptz not null default now()
);

-- ------------------------------------------------------------ autonomy policy
create table autonomy_policies (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id),
  workflow_key text,
  action_type text,
  risk_level text check (risk_level in ('low', 'medium', 'high', 'critical')),
  autonomy_level smallint not null check (autonomy_level between 0 and 4),
  reason text not null default '',
  created_by uuid,
  created_at timestamptz not null default now()
);
-- At most one policy per exact scope tuple
create unique index autonomy_policies_scope on autonomy_policies (
  coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(workflow_key, ''),
  coalesce(action_type, ''),
  coalesce(risk_level, '')
);

-- +migrate down
drop table autonomy_policies;
drop table agent_evaluations;
drop table agent_versions;
drop table agent_definitions;
drop table quality_gate_results;
drop table workflow_exceptions;
drop table workflow_approvals;
drop table workflow_signals;
drop table workflow_transitions;
drop table node_runs;
drop table workflow_runs;
drop table workflow_edges;
drop table workflow_nodes;
drop table workflow_versions;
drop table workflow_definitions;
