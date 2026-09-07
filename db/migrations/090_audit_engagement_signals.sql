-- +migrate up
-- Spec 098 (prospecting cockpit): behavioral audit engagement. Additive only.
--
-- prospect_audit_views gains attribution columns, stamped at INSERT by the
-- page render (the table stays insert-only — forbid_mutation is untouched):
--   link_key  — the branded-link key (spec 076) the visit arrived through.
--               The branded link is the one we email, so a key-bearing view
--               is "arrived via the emailed link"; a bare-token view is
--               unattributed external activity. Never a claim about WHO.
--   referrer  — the Referer header, raw, for read-time interpretation.
--
-- prospect_audit_engagement_events: raw client beacons from the audit page
-- (engaged time, scroll milestones, section/evidence/CTA interaction), each
-- tied to the server-side view row that rendered the page. session_id and
-- visitor_id are random browser-generated ids (sessionStorage/localStorage),
-- not fingerprints — they let us say "3 sessions, 2 browser identities",
-- never "their marketing director opened it". Insert-only like every other
-- evidence table; interpretation (thresholds, scoring) happens at read time
-- so historical batches are never rewritten when the scoring changes.

alter table prospect_audit_views add column link_key text;
alter table prospect_audit_views add column referrer text;

create table prospect_audit_engagement_events (
  id uuid primary key default gen_random_uuid(),
  view_id uuid not null references prospect_audit_views(id),
  session_id text not null,
  visitor_id text,
  kind text not null check (kind in
    ('engaged_time', 'scroll', 'section_viewed', 'evidence_expanded', 'cta_clicked')),
  -- engaged_time: cumulative engaged seconds for the view (max wins at read);
  -- scroll: milestone percent (25/50/75/90); section_viewed: null.
  value int,
  -- section key for section_viewed / evidence_expanded / cta_clicked.
  target text,
  occurred_at timestamptz not null default now()
);
create index prospect_audit_engagement_events_view_idx
  on prospect_audit_engagement_events (view_id, kind);

create trigger prospect_audit_engagement_events_immutable
  before update or delete on prospect_audit_engagement_events
  for each row execute function forbid_mutation();

-- +migrate down
drop table prospect_audit_engagement_events;
alter table prospect_audit_views drop column referrer;
alter table prospect_audit_views drop column link_key;
