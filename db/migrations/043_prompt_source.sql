-- Spec 035: prompt provenance. Where a prompt came from changes how much
-- an operator trusts it and how import dedupe reports it. Existing rows
-- default to 'manual' — honest, since everything so far arrived through
-- the hand-typed path (vertical packs included; pack rows created after
-- this migration record 'vertical_pack').

-- +migrate up
alter table prompts add column source text not null default 'manual'
  check (source in ('manual', 'import', 'vertical_pack', 'expansion'));

-- +migrate down
alter table prompts drop column source;
