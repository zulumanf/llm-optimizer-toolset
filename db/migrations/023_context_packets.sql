-- Spec 022: task-specific context packets.
--
-- Design notes the column list does not carry:
--  * `evidence_packets` is EXTENDED, not forked. It already reads approved
--    claims only, filters privacy at retrieval, records what it withheld,
--    attaches contradictions and disclaimers, and hashes its content. Creating
--    a second packet table would give this codebase two answers to "what was
--    the agent shown?", which is one too many.
--  * Adding columns to an insert-only table is fine: `forbid_mutation()`
--    blocks row UPDATE/DELETE, not schema evolution. Migration 011 set the
--    precedent when it added hash columns to `responses`.
--  * `context_packet_items` IS the explanation feature. Every included and
--    every excluded item carries its reason, so "why is that fact missing?"
--    has a stored answer instead of requiring a re-run.
--  * Packet access is written to `audit_log`. One audit system.

-- +migrate up

alter table evidence_packets
  add column template_key text,
  add column agent_key text,
  add column task_objective text not null default '',
  add column audience text not null default 'internal',
  add column token_count integer not null default 0,
  add column token_budget integer,
  add column freshness_floor text,
  -- The validation verdict, stored so a rejected packet is auditable rather
  -- than merely absent.
  add column validation jsonb not null default '{}'::jsonb,
  -- Knowledge the task needed and the platform did not have. Disclosed to the
  -- agent, not silently omitted.
  add column missing_context jsonb not null default '[]'::jsonb,
  -- Packets stay readable forever for audit; they stop being valid INPUTS.
  add column expires_at timestamptz;

create index evidence_packets_template_idx
  on evidence_packets (template_key, built_at desc);

create table context_packet_items (
  id uuid primary key default gen_random_uuid(),
  packet_id uuid not null references evidence_packets(id),
  item_type text not null check (item_type in (
    'hot_file', 'wiki_section', 'claim', 'evidence', 'instruction',
    'contradiction', 'workflow_state', 'task_input', 'methodology'
  )),
  item_ref text not null,
  label text not null default '',
  priority_class smallint not null default 9,
  -- A named deterministic rule, or a retrieval score. Never "it seemed relevant".
  selection_reason text not null,
  retrieval_score numeric(6,4),
  token_cost integer not null default 0,
  freshness_status text,
  privacy_status text,
  included boolean not null default true,
  exclusion_reason text,
  position smallint not null default 0,
  created_at timestamptz not null default now()
);
create index context_packet_items_packet_idx
  on context_packet_items (packet_id, included, position);
create trigger context_packet_items_immutable
  before update or delete on context_packet_items
  for each row execute function forbid_mutation();

-- Mirrored from the code registry the way agent_definitions already is, so the
-- UI and audit joins have stable ids without the templates leaving code.
create table context_packet_templates (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  name text not null,
  description text not null default '',
  version text not null,
  required_categories text[] not null default '{}',
  required_instruction_types text[] not null default '{}',
  excluded_categories text[] not null default '{}',
  default_token_budget integer not null,
  min_freshness text not null default 'unknown',
  allowed_privacy text[] not null default '{}',
  prohibited_source_types text[] not null default '{}',
  requires_claims boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- +migrate down
drop table context_packet_templates;
drop table context_packet_items;
drop index evidence_packets_template_idx;
alter table evidence_packets
  drop column expires_at,
  drop column missing_context,
  drop column validation,
  drop column freshness_floor,
  drop column token_budget,
  drop column token_count,
  drop column audience,
  drop column task_objective,
  drop column agent_key,
  drop column template_key;
