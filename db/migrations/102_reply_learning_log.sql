-- +migrate up
-- First-positive-reply forensic (2026-09-04): one derived, read-only row per
-- delivered competitive-mismatch Touch 1, joining the frozen evidence snapshot
-- (walked up the draft parent chain, since the 2026-08-31 rewrites carry none),
-- the reply ledger, open signal, private-report publishes/views, walkthrough
-- requests and stage history. Nothing is persisted twice: every column is a
-- projection of canonical tables. Mismatch strength is NOT computed here —
-- `mismatchStrength` in lib/prospects/mismatch.ts is the one implementation;
-- scripts/positive-reply-forensic.ts applies it over this view.

-- Spec 125's open classification (097_open_signal_view.sql) is applied on
-- prod but was never merged; restating it idempotently so every environment
-- that runs this migration can read signal_class.
create or replace view outreach_open_signal as
select o.id, o.send_id, o.opened_at, o.ip, o.user_agent,
  case
    when o.user_agent is null or o.user_agent = 'Mozilla/5.0' then 'scanner'
    when o.user_agent like '%GoogleImageProxy%' or o.user_agent like '%ggpht%' then 'proxy'
    else 'browser'
  end as signal_class
from outreach_email_opens o;

create view outreach_reply_learning_log as
with recursive chain as (
  select s.id as send_id, s.prospect_id, s.sent_at, s.recipient_email,
         d.id as node_id, d.parent_id, d.evidence_snapshot, d.touch_number,
         d.contact_id, d.sequence_id, 0 as depth
  from prospect_outreach_sends s
  join outreach_drafts d on d.id = s.draft_id
  where s.allowed and coalesce(d.touch_number, 1) = 1
  union all
  select c.send_id, c.prospect_id, c.sent_at, c.recipient_email,
         d.id, d.parent_id, d.evidence_snapshot, c.touch_number,
         coalesce(c.contact_id, d.contact_id), c.sequence_id, c.depth + 1
  from chain c
  join outreach_drafts d on d.id = c.parent_id
  where c.evidence_snapshot is null and c.depth < 20
),
touch1 as (
  select distinct on (send_id) send_id, prospect_id, sent_at, recipient_email,
         evidence_snapshot as snap, contact_id, sequence_id
  from chain
  where evidence_snapshot ->> 'templateVersion' like 'competitive_mismatch%'
  order by send_id, depth
),
seq as (
  select prospect_id, touch1_send_id, experiment_id, timezone, status as sequence_status,
         stop_reason, distinct_competitor_questions
  from outreach_followup_sequences
),
first_reply as (
  select r.prospect_id, r.received_at, r.classification, r.send_id
  from (
    select r.*, row_number() over (partition by r.prospect_id order by r.received_at, r.created_at desc) as rn
    from prospect_replies r
    where r.classification not in ('out_of_office', 'unsubscribe')
  ) r where r.rn = 1
),
positive as (
  select prospect_id, min(received_at) as received_at
  from prospect_replies where classification = 'positive_interest' group by prospect_id
),
report as (
  select a.prospect_id, min(a.published_at) as published_at
  from prospect_audits a where a.snapshot -> 'mismatch' is not null group by a.prospect_id
),
report_view as (
  select a.prospect_id, min(v.viewed_at) as viewed_at
  from prospect_audit_views v join prospect_audits a on a.id = v.audit_id
  where a.snapshot -> 'mismatch' is not null and not v.is_internal
    and v.ip not in ('::1', '127.0.0.1') and coalesce(v.user_agent, '') not ilike 'curl/%'
  group by a.prospect_id
),
walkthrough as (
  select prospect_id, min(created_at) as requested_at from prospect_walkthrough_requests group by prospect_id
),
stage_first as (
  select prospect_id,
    min(changed_at) filter (where to_stage in ('discovery_scheduled')) as call_booked_at,
    min(changed_at) filter (where to_stage in ('proposal_sent')) as offer_made_at,
    min(changed_at) filter (where to_stage in ('contracted')) as client_won_at
  from prospect_stage_history group by prospect_id
)
select
  t.prospect_id,
  p.business_name,
  s.experiment_id as campaign,
  l.name as market,
  t.recipient_email as recipient,
  -- Same rule as the cockpit/analytics "delivered = sent minus bounce suppression".
  exists (select 1 from suppression_entries se
          where se.lifted_at is null and se.reason ilike '%bounce%'
            and se.normalized_value = lower(t.recipient_email)) as bounced,
  c.provenance as contact_provenance,
  p.prospect_type as team_or_agent,
  t.snap ->> 'templateVersion' as template_version,
  t.send_id as touch1_send_id,
  t.sent_at,
  (t.sent_at at time zone coalesce(s.timezone, 'America/New_York')) as sent_at_local,
  extract(isodow from (t.sent_at at time zone coalesce(s.timezone, 'America/New_York')))::int as sent_isodow,
  extract(hour from (t.sent_at at time zone coalesce(s.timezone, 'America/New_York')))::int as sent_local_hour,
  (t.snap -> 'prospect' ->> 'productionValue')::bigint as production_prospect,
  (t.snap -> 'competitor' ->> 'productionValue')::bigint as production_competitor,
  (t.snap -> 'competitor' ->> 'productionRatio')::numeric as production_ratio,
  (t.snap -> 'prospect' ->> 'productionValue')::bigint
    - (t.snap -> 'competitor' ->> 'productionValue')::bigint as production_difference,
  (t.snap -> 'prospect' ->> 'recommendationCount')::int as recommendations_prospect,
  (t.snap -> 'competitor' ->> 'recommendationCount')::int as recommendations_competitor,
  (t.snap -> 'competitor' ->> 'recommendationGap')::int as recommendation_gap,
  (t.snap ->> 'answerCount')::int as denominator,
  t.snap -> 'competitor' ->> 'name' as competitor,
  s.distinct_competitor_questions,
  fr.received_at as reply_at,
  fr.classification as reply_classification,
  coalesce(rd.touch_number, 1) as reply_touch_number,
  round(extract(epoch from (fr.received_at - t.sent_at)) / 3600.0, 2) as hours_to_reply,
  (pos.received_at is not null) as positive_reply,
  pos.received_at as positive_reply_at,
  (select count(*)::int from outreach_open_signal o
     where o.send_id = t.send_id and o.opened_at < coalesce(fr.received_at, 'infinity'::timestamptz)) as any_opens_before_reply,
  (select count(*)::int from outreach_open_signal o
     where o.send_id = t.send_id and o.signal_class <> 'scanner'
       and o.opened_at < coalesce(fr.received_at, 'infinity'::timestamptz)) as credible_opens_before_reply,
  (select count(*)::int from outreach_open_signal o
     where o.send_id = t.send_id and o.signal_class <> 'scanner') as credible_opens_total,
  (select min(o.opened_at) from outreach_open_signal o
     where o.send_id = t.send_id and o.signal_class <> 'scanner') as first_credible_open_at,
  s.sequence_status,
  s.stop_reason as sequence_stop_reason,
  (pos.received_at is not null) as report_requested,
  rp.published_at as report_published_at,
  (select min(s2.sent_at) from prospect_outreach_sends s2
     where s2.prospect_id = t.prospect_id and s2.allowed and s2.sent_at > coalesce(fr.received_at, 'infinity'::timestamptz)) as report_sent_at,
  rv.viewed_at as report_viewed_at,
  w.requested_at as walkthrough_requested_at,
  sf.call_booked_at,
  sf.offer_made_at,
  sf.client_won_at,
  p.stage as current_stage
from touch1 t
join prospects p on p.id = t.prospect_id
left join market_launches l on l.id = p.launch_id
left join seq s on s.prospect_id = t.prospect_id
left join prospect_contacts c on c.id = t.contact_id
left join first_reply fr on fr.prospect_id = t.prospect_id
left join prospect_outreach_sends rs on rs.id = fr.send_id
left join outreach_drafts rd on rd.id = rs.draft_id
left join positive pos on pos.prospect_id = t.prospect_id
left join report rp on rp.prospect_id = t.prospect_id
left join report_view rv on rv.prospect_id = t.prospect_id
left join walkthrough w on w.prospect_id = t.prospect_id
left join stage_first sf on sf.prospect_id = t.prospect_id;

-- +migrate down
drop view outreach_reply_learning_log;
-- Only drop the open-signal view if this migration introduced it (prod has
-- it from 097, which stays applied).
do $$ begin
  if not exists (select 1 from schema_migrations where name = '097_open_signal_view.sql') then
    drop view outreach_open_signal;
  end if;
end $$;
