-- +migrate up
-- Spec 053: fleet-level drift detection. A provider change across N clients
-- must be ONE signal naming them all, never N client-specific insights.

create table drift_signals (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in
    ('fleet_movement', 'provider_shape', 'sentinel_deviation')),
  provider text not null,
  metric text,
  direction text check (direction in ('up', 'down')),
  -- Mean |delta| across affected projects (rates, 0..1); null for shape drift
  magnitude numeric,
  -- [{projectId, projectName, delta}] — the receipts behind the summary
  affected jsonb not null default '[]',
  summary text not null,
  detail jsonb not null default '{}',
  detector_version text not null,
  status text not null default 'open' check (status in ('open', 'acknowledged')),
  acknowledged_by uuid references users(id),
  acknowledged_at timestamptz,
  acknowledged_note text,
  detected_at timestamptz not null default now()
);

-- One OPEN signal per fingerprint: re-running the detector dedupes instead
-- of stacking duplicates; acknowledging re-arms detection for a recurrence.
create unique index drift_signals_open_unique
  on drift_signals (kind, provider, coalesce(metric, ''), coalesce(direction, ''))
  where status = 'open';
create index drift_signals_status_idx on drift_signals (status, detected_at desc);

-- The adapter's shape verdict, persisted (audit P0: shapeRecognized=false
-- died in a log line). Null = the capture predates this column.
alter table responses add column shape_recognized boolean;

-- Sentinel projects measure deliberately stable entities on the ordinary
-- measurement stack; on a sentinel, movement IS the anomaly. Existing
-- kind='client' filters keep sentinels off client and portfolio surfaces.
alter table projects drop constraint projects_kind_check;
alter table projects add constraint projects_kind_check
  check (kind in ('client', 'prospect', 'sentinel'));

-- +migrate down
alter table projects drop constraint projects_kind_check;
update projects set kind = 'client' where kind = 'sentinel';
alter table projects add constraint projects_kind_check
  check (kind in ('client', 'prospect'));
alter table responses drop column shape_recognized;
drop table drift_signals;
