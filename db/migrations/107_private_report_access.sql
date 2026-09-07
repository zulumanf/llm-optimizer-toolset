-- Spec 134: private report access. A human-readable report slug per prospect,
-- authorized report sessions minted from an invitation (the existing branded
-- key or a legacy audit token), an insert-only access-event ledger, and a
-- session stamp on every audit view. Nothing here touches audit snapshots or
-- existing keys/tokens: every link already emailed keeps validating exactly
-- as before and then rides the new exchange.

-- +migrate up
alter table prospects add column report_slug text;
create unique index prospects_report_slug_unique
  on prospects (report_slug) where report_slug is not null;

-- Backfill: every prospect that ever had an audit gets a stable slug. Base is
-- the active branded-link slug (what the prospect has already seen) or the
-- kebab-cased business name; collisions take the market name, then a number.
with base as (
  select p.id, p.created_at,
    coalesce(
      (select l.slug from prospect_audit_links l where l.prospect_id = p.id
        order by (l.revoked_at is null) desc, l.created_at desc limit 1),
      nullif(regexp_replace(regexp_replace(lower(replace(p.business_name, '&', ' and ')),
        '[^a-z0-9]+', '-', 'g'), '(^-+|-+$)', '', 'g'), ''),
      'report') as base_slug,
    nullif(regexp_replace(regexp_replace(lower(split_part(m.name, ',', 1)), '[^a-z0-9]+', '-', 'g'),
      '(^-+|-+$)', '', 'g'), '') as market_slug
  from prospects p
  join market_launches ml on ml.id = p.launch_id
  join markets m on m.id = ml.market_id
  where exists (select 1 from prospect_audits a where a.prospect_id = p.id)
),
ranked as (
  select *, row_number() over (partition by base_slug order by created_at, id) as rn from base
),
candidate as (
  select id, created_at,
    case when rn = 1 then base_slug
         else base_slug || '-' || coalesce(market_slug, rn::text) end as slug
  from ranked
),
ranked2 as (
  select *, row_number() over (partition by slug order by created_at, id) as rn2 from candidate
)
update prospects p set report_slug =
  case when r.rn2 = 1 then r.slug else r.slug || '-' || r.rn2::text end
from ranked2 r where r.id = p.id;

alter table prospect_audit_links add column session_allowance int not null default 5
  check (session_allowance > 0);

create table prospect_report_sessions (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid not null references prospects(id),
  audit_id uuid not null references prospect_audits(id),
  link_id uuid references prospect_audit_links(id),
  token_hash text not null,
  is_internal boolean not null default false,
  user_agent text,
  created_at timestamptz not null default now(),
  first_used_at timestamptz,
  last_seen_at timestamptz,
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create unique index prospect_report_sessions_token_unique on prospect_report_sessions (token_hash);
create index prospect_report_sessions_prospect_idx on prospect_report_sessions (prospect_id, created_at desc);
create index prospect_report_sessions_link_idx on prospect_report_sessions (link_id) where link_id is not null;

create table prospect_report_access_events (
  id uuid primary key default gen_random_uuid(),
  prospect_id uuid not null references prospects(id),
  audit_id uuid references prospect_audits(id),
  link_id uuid references prospect_audit_links(id),
  session_id uuid references prospect_report_sessions(id),
  kind text not null check (kind in
    ('invitation_opened', 'access_granted', 'session_created', 'access_refused')),
  is_internal boolean not null default false,
  detail jsonb not null default '{}',
  occurred_at timestamptz not null default now()
);
create index prospect_report_access_events_prospect_idx
  on prospect_report_access_events (prospect_id, occurred_at desc);
create trigger prospect_report_access_events_immutable
  before update or delete on prospect_report_access_events
  for each row execute function forbid_mutation();

alter table prospect_audit_views add column session_id uuid references prospect_report_sessions(id);
create index prospect_audit_views_session_idx on prospect_audit_views (session_id) where session_id is not null;

-- +migrate down
drop index prospect_audit_views_session_idx;
alter table prospect_audit_views drop column session_id;
drop trigger prospect_report_access_events_immutable on prospect_report_access_events;
drop index prospect_report_access_events_prospect_idx;
drop table prospect_report_access_events;
drop index prospect_report_sessions_link_idx;
drop index prospect_report_sessions_prospect_idx;
drop index prospect_report_sessions_token_unique;
drop table prospect_report_sessions;
alter table prospect_audit_links drop column session_allowance;
drop index prospects_report_slug_unique;
alter table prospects drop column report_slug;
