-- +migrate up
-- Spec 058: learnings become retrievable BY SITUATION. The ledger had
-- excellent integrity and no way to ask "what happened last time we ran
-- this play for this kind of gap in this market" (audit F35) — and a
-- learning about a play never said which way it cut.
alter table learnings add column gap_type text;
alter table learnings add column play_key text;
alter table learnings add column market_id uuid references markets(id);
alter table learnings add column intervention_id uuid references interventions(id);
alter table learnings add column cost_usd numeric;
alter table learnings add column scoring_version text;
alter table learnings add column direction text not null default 'supports'
  check (direction in ('supports', 'cautions'));

create index learnings_play_idx on learnings (play_key, status)
  where play_key is not null;
create index learnings_gap_idx on learnings (gap_type, status)
  where gap_type is not null;

-- +migrate down
drop index learnings_gap_idx;
drop index learnings_play_idx;
alter table learnings drop column direction;
alter table learnings drop column scoring_version;
alter table learnings drop column cost_usd;
alter table learnings drop column intervention_id;
alter table learnings drop column market_id;
alter table learnings drop column play_key;
alter table learnings drop column gap_type;
