-- Spec 019: executive intelligence & control tower.
--
-- Every table here is append-only. A health score, a capacity estimate, and a
-- delivered brief are all *measurements*: recomputing writes a new row so last
-- month's number stays exactly what the client was told (PRINCIPLES #2).

-- +migrate up

create table client_health_snapshots (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id),
  period_start date not null,
  period_end date not null,
  weights_version text not null,
  -- Overall is a weighted mean of PRESENT components only; absent components
  -- lower `confidence` rather than silently scoring zero.
  overall numeric(4,3),
  components jsonb not null,
  missing text[] not null default '{}',
  confidence numeric(4,3) not null,
  evidence jsonb not null default '{}'::jsonb,
  computed_at timestamptz not null default now()
);
create index client_health_project_idx
  on client_health_snapshots (project_id, period_end desc);
create trigger client_health_snapshots_immutable
  before update or delete on client_health_snapshots
  for each row execute function forbid_mutation();

create table action_outcomes (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id),
  -- Provenance of the action: any of these may be null depending on the path
  gap_finding_id uuid references gap_findings(id),
  task_id uuid references tasks(id),
  content_asset_id uuid references content_assets(id),
  intervention_id uuid references interventions(id),
  workflow_run_id uuid references workflow_runs(id),
  action_type text not null,
  hypothesis text not null default '',
  state_before jsonb not null default '{}'::jsonb,
  assets jsonb not null default '[]'::jsonb,
  prompt_cluster_keys text[] not null default '{}',
  landing_urls text[] not null default '{}',
  completed_on date,
  expected_days_to_impact integer,
  -- Before/after measurement envelope. NULL means "not measured", which the
  -- effectiveness label must reflect — never treated as zero.
  visibility_before numeric, visibility_after numeric,
  citations_before integer,  citations_after integer,
  traffic_before integer,    traffic_after integer,
  leads_before integer,      leads_after integer,
  pipeline_before numeric,   pipeline_after numeric,
  effectiveness text not null default 'insufficient_measurement'
    check (effectiveness in (
      'positive_signal', 'no_detectable_change', 'negative_signal',
      'inconclusive', 'insufficient_measurement', 'confounded')),
  confidence numeric(4,3),
  confounders text[] not null default '{}',
  human_interpretation text,
  evidence_ids uuid[] not null default '{}',
  measured_at timestamptz,
  created_at timestamptz not null default now()
);
create index action_outcomes_project_idx on action_outcomes (project_id, created_at desc);
create index action_outcomes_effect_idx on action_outcomes (effectiveness);

create table outcome_relationships (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id),
  from_kind text not null,
  from_id uuid not null,
  to_kind text not null,
  to_id uuid not null,
  relation text not null,
  -- The whole point of this table. `confirmed` requires a matching identifier
  -- or a human decision; correlation is never auto-promoted (docs/audits #10).
  confidence_label text not null check (confidence_label in (
    'confirmed', 'strongly_supported', 'correlated', 'probable', 'unknown')),
  basis text not null,
  evidence_ids uuid[] not null default '{}',
  created_by_kind text not null default 'deterministic'
    check (created_by_kind in ('human', 'deterministic', 'agent')),
  created_by uuid,
  created_at timestamptz not null default now()
);
create unique index outcome_relationships_edge
  on outcome_relationships (from_kind, from_id, to_kind, to_id, relation);
create index outcome_relationships_project_idx on outcome_relationships (project_id);
create trigger outcome_relationships_immutable
  before update or delete on outcome_relationships
  for each row execute function forbid_mutation();

create table operator_capacity_snapshots (
  id uuid primary key default gen_random_uuid(),
  period_start date not null,
  period_end date not null,
  active_clients integer not null,
  human_minutes_total numeric not null,
  human_minutes_by_client jsonb not null default '{}'::jsonb,
  exceptions_total integer not null default 0,
  approvals_total integer not null default 0,
  manual_overrides integer not null default 0,
  automation_rate numeric(4,3),
  -- NULL when observations are below the minimum needed to say anything
  supportable_clients numeric,
  observation_count integer not null default 0,
  notes text not null default '',
  computed_at timestamptz not null default now()
);
create index operator_capacity_period_idx on operator_capacity_snapshots (period_end desc);
create trigger operator_capacity_immutable
  before update or delete on operator_capacity_snapshots
  for each row execute function forbid_mutation();

create table executive_briefs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id),
  kind text not null check (kind in ('weekly', 'monthly', 'quarterly')),
  period_start date not null,
  period_end date not null,
  workflow_run_id uuid references workflow_runs(id),
  status text not null default 'draft'
    check (status in ('draft', 'approved', 'delivered')),
  -- Sections are typed statements, each carrying its own evidence ids and a
  -- claim_kind of fact | calculation | interpretation | recommendation |
  -- correlation | causal | unknown (spec 019).
  sections jsonb not null,
  materiality jsonb not null default '{}'::jsonb,
  evidence_ids uuid[] not null default '{}',
  generated_by text not null default 'deterministic',
  approved_by uuid,
  approved_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now()
);
create index executive_briefs_project_idx
  on executive_briefs (project_id, period_end desc);
create unique index executive_briefs_one_draft
  on executive_briefs (project_id, kind, period_start) where status = 'draft';

-- +migrate down
drop table executive_briefs;
drop table operator_capacity_snapshots;
drop table outcome_relationships;
drop table action_outcomes;
drop table client_health_snapshots;
