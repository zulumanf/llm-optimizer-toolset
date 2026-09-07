/**
 * Acquisition control panel — the one facts bundle the Analyze tab derives
 * everything from (lib/prospects/acquisition.ts). Read-only aggregate
 * queries over the existing ledgers: sends, drafts, sequences, replies,
 * corrections, audits, RealTrends matches, engagements. Nothing here
 * persists a metric; change the rules and every number re-derives.
 *
 * Truth filters live here, not in the UI:
 * - Touch 1 identity follows the draft chain to the frozen mismatch
 *   snapshot (rewrites carry no template version) and EXCLUDES founder
 *   replies, report deliveries and evidence corrections even when their
 *   chain reaches a snapshot (the report reply otherwise counts as a
 *   second Touch 1).
 * - QA fixtures (QA131 markets/launches/projects) and archived rows never
 *   count anywhere; signed fixture engagements are not clients.
 * - A hard bounce is either a suppression entry or a contact marked
 *   do-not-contact for a hard bounce (the 2026-09-01 relay bounce has only
 *   the latter).
 */
import { sql } from "@/db/client";
import { humanViews, machineHealth } from "@/lib/prospects/dashboard";
import {
  ENGAGEMENT_OFFER,
  MISMATCH_TEMPLATE_VERSION,
  PRICING_REQUEST_RE,
  QA_FIXTURE_NAME_PREFIX,
  REPORT_DELIVERY_TEMPLATE_VERSION,
} from "@/lib/prospects/constants";
import { STRONG_CORRECTION_TEMPLATE_VERSION } from "@/lib/prospects/correction-templates";
import { MISMATCH_PROVIDER } from "@/lib/prospects/mismatch";
import { CURRENT } from "@/lib/prospects/benchmark";
import { PROMPT_ECHO_EXCLUDED } from "@/lib/scoring/prompt-echo";
import { OPERATOR_TIMEZONE } from "@/lib/prospects/intent";
import type {
  AcquisitionFacts,
  CompetitorRankFact,
  Era1Fact,
  MarketSupplyFact,
  OpportunityFact,
  QueuedDraftFact,
  RefusalFact,
  ReplyFact,
  ReportFact,
  SequenceFact,
  SequenceStatus,
  T1Fact,
  TouchSendFact,
} from "@/lib/prospects/acquisition";

const fixture = `${QA_FIXTURE_NAME_PREFIX}%`;
/** A successful Gmail transmit inside this window proves the send path. */
const GMAIL_LIVENESS_MS = 72 * 3_600_000;
const d = (v: unknown): Date | null => (v ? new Date(v as Date) : null);
const n = (v: unknown): number => Number(v ?? 0);

/** Touch 1 sends of the current experiment: draft chain → frozen snapshot. */
async function touch1(): Promise<T1Fact[]> {
  const rows = await sql`
    with recursive chain as (
      select s.id as send_id, dr.id, dr.parent_id, dr.evidence_snapshot, 0 as depth
      from prospect_outreach_sends s
      join outreach_drafts dr on dr.id = s.draft_id
      where s.allowed and dr.touch_number is null and dr.reply_to_id is null
        and coalesce(dr.prompt_version, '') not in (${REPORT_DELIVERY_TEMPLATE_VERSION}, ${STRONG_CORRECTION_TEMPLATE_VERSION})
      union all
      select c.send_id, p.id, p.parent_id, p.evidence_snapshot, c.depth + 1
      from chain c join outreach_drafts p on p.id = c.parent_id
      where c.evidence_snapshot is null and c.depth < 20
    ),
    t1 as (
      select distinct on (send_id) send_id, evidence_snapshot as snap from chain
      where evidence_snapshot ->> 'templateVersion' like 'competitive_mismatch%'
      order by send_id, depth
    )
    select s.id as send_id, s.prospect_id, p.business_name, p.prospect_type, p.launch_id, l.name as market, s.sent_at,
      t.snap ->> 'runId' as run_id,
      t.snap -> 'competitor' ->> 'companyId' as competitor_company_id,
      t.snap -> 'competitor' ->> 'name' as competitor_name,
      (t.snap -> 'prospect' ->> 'recommendationCount')::int as recs_prospect,
      (t.snap -> 'competitor' ->> 'recommendationCount')::int as recs_competitor,
      (t.snap -> 'competitor' ->> 'productionRatio')::float as production_ratio,
      (exists (select 1 from suppression_entries se where se.lifted_at is null and se.reason ilike '%bounce%'
                 and se.normalized_value = lower(s.recipient_email))
       or exists (select 1 from prospect_contacts c where c.prospect_id = s.prospect_id and c.do_not_contact
                 and c.do_not_contact_reason ilike 'hard_bounce%' and lower(c.email) = lower(s.recipient_email))) as bounced,
      (co.corrected_snapshot -> 'prospect' ->> 'recommendationCount')::int as corrected_prospect,
      (co.corrected_snapshot -> 'competitor' ->> 'recommendationCount')::int as corrected_competitor,
      (select count(*)::int from outreach_open_signal o where o.send_id = s.id) as any_opens,
      (select count(*)::int from outreach_open_signal o where o.send_id = s.id and o.signal_class <> 'scanner') as credible_opens
    from t1 t
    join prospect_outreach_sends s on s.id = t.send_id
    join prospects p on p.id = s.prospect_id
    join market_launches l on l.id = p.launch_id
    left join lateral (
      select corrected_snapshot from outreach_evidence_corrections c
      where c.prospect_id = s.prospect_id and (c.send_id = s.id or c.send_id is null)
      order by corrected_at desc limit 1
    ) co on true
    where p.archived_at is null and l.name not like ${fixture}
    order by s.sent_at
  `;
  return rows.map((r) => ({
    sendId: r.sendId as string,
    prospectId: r.prospectId as string,
    businessName: r.businessName as string,
    market: r.market as string,
    launchId: r.launchId as string,
    prospectType: (r.prospectType as string | null) ?? null,
    sentAt: new Date(r.sentAt as Date),
    bounced: Boolean(r.bounced),
    runId: (r.runId as string | null) ?? null,
    competitorCompanyId: (r.competitorCompanyId as string | null) ?? null,
    competitorName: (r.competitorName as string | null) ?? null,
    recsProspect: n(r.recsProspect),
    recsCompetitor: n(r.recsCompetitor),
    competitorProductionRatio: r.productionRatio === null || r.productionRatio === undefined ? null : Number(r.productionRatio),
    correctedProspect: r.correctedProspect === null || r.correctedProspect === undefined ? null : Number(r.correctedProspect),
    correctedCompetitor: r.correctedCompetitor === null || r.correctedCompetitor === undefined ? null : Number(r.correctedCompetitor),
    anyOpens: n(r.anyOpens),
    credibleOpens: n(r.credibleOpens),
  }));
}

async function replies(): Promise<ReplyFact[]> {
  const rows = await sql`
    select r.prospect_id, r.received_at, r.created_at, r.classification, r.body_text
    from prospect_replies r join prospects p on p.id = r.prospect_id
    where p.archived_at is null order by r.received_at, r.created_at
  `;
  return rows.map((r) => ({
    prospectId: r.prospectId as string,
    receivedAt: new Date(r.receivedAt as Date),
    createdAt: new Date(r.createdAt as Date),
    classification: r.classification as string,
    pricingRequested: PRICING_REQUEST_RE.test((r.bodyText as string) ?? ""),
  }));
}

async function sequences(): Promise<SequenceFact[]> {
  const rows = await sql`
    select q.id, q.prospect_id, q.status, q.next_touch, q.next_due_at, q.paused_until, q.pause_reason, q.stop_reason
    from outreach_followup_sequences q join prospects p on p.id = q.prospect_id where p.archived_at is null
  `;
  return rows.map((r) => ({
    id: r.id as string,
    prospectId: r.prospectId as string,
    status: r.status as SequenceStatus,
    nextTouch: r.nextTouch === null || r.nextTouch === undefined ? null : (Number(r.nextTouch) as 2 | 3),
    nextDueAt: d(r.nextDueAt),
    pausedUntil: d(r.pausedUntil),
    pauseReason: (r.pauseReason as string | null) ?? null,
    stopReason: (r.stopReason as string | null) ?? null,
  }));
}

/** Follow-up touches, founder replies (report deliveries) and corrections. */
async function touchSends(): Promise<TouchSendFact[]> {
  const offerMarker = `%${ENGAGEMENT_OFFER.monthlyUsd.toLocaleString("en-US")}%`;
  const rows = await sql`
    select s.prospect_id, s.sent_at,
      case
        when dr.prompt_version = ${STRONG_CORRECTION_TEMPLATE_VERSION} then 'CORRECTION'
        when dr.reply_to_id is not null or dr.prompt_version = ${REPORT_DELIVERY_TEMPLATE_VERSION} then 'FOUNDER'
        when dr.sequence_id is not null and dr.touch_number = 2 then 'T2'
        when dr.sequence_id is not null and dr.touch_number = 3 then 'T3'
      end as kind,
      (dr.body like ${offerMarker}) as offer_presented
    from prospect_outreach_sends s join outreach_drafts dr on dr.id = s.draft_id join prospects p on p.id = s.prospect_id
    where s.allowed and p.archived_at is null
      and (dr.prompt_version in (${STRONG_CORRECTION_TEMPLATE_VERSION}, ${REPORT_DELIVERY_TEMPLATE_VERSION})
           or dr.reply_to_id is not null or (dr.sequence_id is not null and dr.touch_number in (2, 3)))
  `;
  return rows.map((r) => ({
    prospectId: r.prospectId as string,
    kind: r.kind as TouchSendFact["kind"],
    sentAt: new Date(r.sentAt as Date),
    offerPresented: Boolean(r.offerPresented),
  }));
}

/** Private mismatch reports: first publish and first external human-like view. */
async function reports(): Promise<ReportFact[]> {
  const rows = await sql`
    with human_views as (${humanViews()})
    select a.prospect_id, min(a.published_at) as published_at,
      (select min(hv.viewed_at) from human_views hv join prospect_audits a2 on a2.id = hv.audit_id
        where a2.prospect_id = a.prospect_id and a2.snapshot -> 'mismatch' is not null) as first_viewed_at
    from prospect_audits a
    where a.snapshot -> 'mismatch' is not null and a.status = 'published'
    group by a.prospect_id
  `;
  return rows.map((r) => ({ prospectId: r.prospectId as string, publishedAt: d(r.publishedAt), firstViewedAt: d(r.firstViewedAt) }));
}

/** Prospect supply per launch. Contact verified = a live, non-DNC email
 * that was not AI-inferred. Inventory states are for uncontacted prospects. */
async function supply(): Promise<MarketSupplyFact[]> {
  const rows = await sql`
    with base as (
      select p.id, p.launch_id, l.name as market,
        (p.company_id is not null and exists (select 1 from realtrends_records r where r.company_id = p.company_id)) as rt,
        (not p.do_not_contact and exists (select 1 from prospect_contacts c where c.prospect_id = p.id and c.archived_at is null
           and not c.do_not_contact and c.email is not null and coalesce(c.provenance, '') <> 'ai_inferred')) as contactable,
        exists (select 1 from outreach_drafts dr where dr.prospect_id = p.id and dr.evidence_snapshot is not null) as drafted,
        exists (select 1 from prospect_outreach_sends s where s.prospect_id = p.id and s.allowed) as contacted,
        exists (select 1 from outreach_drafts dr where dr.prospect_id = p.id and dr.status = 'approved' and dr.sent_recorded_at is null
           and dr.scheduled_send_at is not null and dr.sequence_id is null and dr.reply_to_id is null) as scheduled,
        exists (select 1 from outreach_drafts dr where dr.prospect_id = p.id and dr.status = 'approved' and dr.sent_recorded_at is null
           and dr.scheduled_send_at is null and dr.last_send_error is null and dr.sequence_id is null and dr.reply_to_id is null) as ready,
        exists (select 1 from outreach_drafts dr where dr.prospect_id = p.id and dr.status = 'approved' and dr.sent_recorded_at is null
           and dr.scheduled_send_at is null and dr.last_send_error is not null and dr.sequence_id is null and dr.reply_to_id is null) as parked,
        exists (select 1 from outreach_drafts dr where dr.prospect_id = p.id and dr.status = 'draft' and dr.evidence_snapshot is not null
           and dr.prompt_version = ${MISMATCH_TEMPLATE_VERSION}) as awaiting
      from prospects p join market_launches l on l.id = p.launch_id
      where p.archived_at is null and l.archived_at is null and l.name not like ${fixture}
    )
    select launch_id, market, count(*)::int as sourced,
      count(*) filter (where rt)::int as rt_matched,
      count(*) filter (where rt and contactable)::int as contactable,
      count(*) filter (where drafted)::int as drafted,
      count(*) filter (where not contacted and scheduled)::int as scheduled,
      count(*) filter (where not contacted and ready and not scheduled)::int as ready,
      count(*) filter (where not contacted and awaiting and not scheduled and not ready)::int as awaiting_approval,
      count(*) filter (where not contacted and parked and not scheduled and not ready)::int as parked
    from base group by launch_id, market order by market
  `;
  return rows.map((r) => ({
    launchId: r.launchId as string,
    market: r.market as string,
    sourced: n(r.sourced),
    rtMatched: n(r.rtMatched),
    contactable: n(r.contactable),
    drafted: n(r.drafted),
    scheduled: n(r.scheduled),
    ready: n(r.ready),
    awaitingApproval: n(r.awaitingApproval),
    parked: n(r.parked),
  }));
}

async function queued(): Promise<QueuedDraftFact[]> {
  const rows = await sql`
    select to_char(dr.scheduled_send_at at time zone ${OPERATOR_TIMEZONE}, 'YYYY-MM-DD') as day,
      case
        when dr.prompt_version = ${STRONG_CORRECTION_TEMPLATE_VERSION} then 'CORRECTION'
        when dr.reply_to_id is not null or dr.prompt_version = ${REPORT_DELIVERY_TEMPLATE_VERSION} then 'FOUNDER'
        when dr.sequence_id is not null and dr.touch_number = 2 then 'T2'
        when dr.sequence_id is not null and dr.touch_number = 3 then 'T3'
        when dr.prompt_version = ${MISMATCH_TEMPLATE_VERSION} or dr.evidence_snapshot is not null then 'T1'
        else 'OTHER'
      end as kind,
      count(*)::int as n
    from outreach_drafts dr join prospects p on p.id = dr.prospect_id
    where dr.status = 'approved' and dr.sent_recorded_at is null and dr.scheduled_send_at is not null and p.archived_at is null
    group by day, kind order by day
  `;
  return rows.map((r) => ({ day: r.day as string, kind: r.kind as QueuedDraftFact["kind"], n: n(r.n) }));
}

/** Era 1 = contacted prospects with no current-experiment Touch 1. */
async function era1(era2Ids: string[]): Promise<Era1Fact> {
  const [r] = await sql`
    select count(distinct s.prospect_id)::int as prospects, count(*)::int as sends,
      count(distinct s.prospect_id) filter (where exists (select 1 from prospect_stage_history h where h.prospect_id = s.prospect_id
        and h.to_stage in ('replied','discovery_scheduled','discovery_completed','proposal_sent','negotiation','verbal_yes','contracted')))::int as replied_stage,
      count(distinct s.prospect_id) filter (where exists (select 1 from prospect_replies r where r.prospect_id = s.prospect_id and r.classification = 'positive_interest'))::int as positive,
      count(distinct s.prospect_id) filter (where exists (select 1 from suppression_entries se where se.lifted_at is null and se.reason ilike '%bounce%' and se.normalized_value = lower(s.recipient_email))
        or exists (select 1 from prospect_contacts c where c.prospect_id = s.prospect_id and c.do_not_contact and c.do_not_contact_reason ilike 'hard_bounce%'))::int as bounced,
      count(distinct s.prospect_id) filter (where exists (select 1 from prospect_audit_views v join prospect_audits a on a.id = v.audit_id
        where a.prospect_id = s.prospect_id and not v.is_internal
          and (v.viewed_at > s.sent_at + interval '10 minutes'
            or exists (select 1 from prospect_report_sessions rs where rs.id = v.session_id and not rs.is_internal))))::int as audit_viewed,
      min(s.sent_at) as first_sent_at, max(s.sent_at) as last_sent_at
    from prospect_outreach_sends s join prospects p on p.id = s.prospect_id join market_launches l on l.id = p.launch_id
    where s.allowed and p.archived_at is null and l.name not like ${fixture}
      and s.prospect_id <> all(${era2Ids}::uuid[])
  `;
  return {
    prospects: n(r?.prospects),
    sends: n(r?.sends),
    repliedStage: n(r?.repliedStage),
    positive: n(r?.positive),
    bounced: n(r?.bounced),
    auditViewed: n(r?.auditViewed),
    firstSentAt: d(r?.firstSentAt),
    lastSentAt: d(r?.lastSentAt),
  };
}

/** Prospects with a positive reply — the live opportunity set, sequence or not. */
async function opportunities(): Promise<OpportunityFact[]> {
  const rows = await sql`
    select p.id, p.business_name, l.name as market, p.stage, p.next_action, p.next_action_on,
      la.kind as last_kind, la.occurred_at as last_at,
      (select max(s.sent_at) from prospect_outreach_sends s where s.prospect_id = p.id and s.allowed) as last_send_at
    from prospects p join market_launches l on l.id = p.launch_id
    left join lateral (select kind, occurred_at from prospect_activities a where a.prospect_id = p.id order by occurred_at desc limit 1) la on true
    where p.archived_at is null and l.name not like ${fixture}
      and exists (select 1 from prospect_replies r where r.prospect_id = p.id and r.classification = 'positive_interest')
  `;
  return rows.map((r) => ({
    prospectId: r.id as string,
    businessName: r.businessName as string,
    market: (r.market as string).split(" —")[0]!.split(" luxury")[0]!.trim(),
    stage: r.stage as string,
    nextAction: (r.nextAction as string | null) ?? null,
    nextActionOn: r.nextActionOn ? String(r.nextActionOn).slice(0, 10) : null,
    lastActivityKind: (r.lastKind as string | null) ?? null,
    lastActivityAt: d(r.lastAt),
    lastSendAt: d(r.lastSendAt),
  }));
}

/** Recommended-count rank of every company inside each evidence run
 * (canonical mention revision, prompt-echo excluded — same rule as the
 * benchmark counter). */
async function competitorRanks(runIds: string[]): Promise<CompetitorRankFact[]> {
  if (runIds.length === 0) return [];
  const rows = await sql`
    select r.run_id, c.id as company_id, count(distinct m.response_id)::int as recommended
    from responses r
    join mentions m on m.response_id = r.id and m.recommended and ${CURRENT}
    join companies c on c.id = m.company_id
    where r.run_id = any(${runIds}::uuid[]) and r.provider = ${MISMATCH_PROVIDER} and r.error is null and ${PROMPT_ECHO_EXCLUDED}
    group by r.run_id, c.id
    order by r.run_id, recommended desc
  `;
  const out: CompetitorRankFact[] = [];
  let run = "", rank = 0, last = -1;
  for (const r of rows) {
    if (r.runId !== run) { run = r.runId as string; rank = 0; last = -1; }
    const rec = n(r.recommended);
    if (rec !== last) { rank += 1; last = rec; }
    out.push({ runId: run, companyId: r.companyId as string, rank });
  }
  return out;
}

async function refusals(): Promise<RefusalFact[]> {
  const rows = await sql`
    select j ->> 'name' as chk, count(*)::int as n, max(s.sent_at) as last_at
    from prospect_outreach_sends s,
      jsonb_array_elements(case when jsonb_typeof(s.gate_verdict -> 'checks') = 'array' then s.gate_verdict -> 'checks' else '[]'::jsonb end) j
    where not s.allowed and (j ->> 'passed') = 'false'
    group by chk order by n desc
  `;
  return rows.map((r) => ({ check: (r.chk as string) ?? "unknown", n: n(r.n), lastAt: new Date(r.lastAt as Date) }));
}

export async function acquisitionFacts(): Promise<AcquisitionFacts> {
  // Sequential on purpose (pooler session cap, see machineHealth).
  const t1 = await touch1();
  const era2Ids = [...new Set(t1.map((x) => x.prospectId))];
  const runIds = [...new Set(t1.flatMap((x) => (x.runId ? [x.runId] : [])))];
  const rep = await replies();
  const seq = await sequences();
  const touches = await touchSends();
  const rpt = await reports();
  const sup = await supply();
  const q = await queued();
  const e1 = await era1(era2Ids);
  const opp = await opportunities();
  const ranks = await competitorRanks(runIds);
  const [clients] = await sql`
    select count(*)::int as n from client_engagements e join markets m on m.id = e.market_id join projects pr on pr.id = e.project_id
    left join prospects p on p.id = e.prospect_id
    where e.contract_status = 'signed' and m.name not like ${fixture} and pr.name not like ${fixture} and (p.id is null or p.archived_at is null)
  `;
  const [spend] = runIds.length
    ? await sql`select sum(cost_usd)::float as usd, count(*)::int as n from runs where id = any(${runIds}::uuid[])`
    : [{ usd: null, n: 0 }];
  const ref = await refusals();
  const [deferrals] = await sql`select count(*)::int as n from prospect_activities where kind = 'scheduled_send_parked' and detail ->> 'reason' ilike '%cap%'`;
  const health = await machineHealth();
  const [lastSend] = await sql`select max(sent_at) as at from prospect_outreach_sends where allowed and channel = 'gmail'`;
  const lastSendAt = d(lastSend?.at);
  return {
    t1,
    replies: rep,
    sequences: seq,
    touchSends: touches,
    reports: rpt,
    supply: sup,
    queued: q,
    era1: e1,
    opportunities: opp,
    competitorRanks: ranks,
    clientsWon: n(clients?.n),
    benchmarkSpendUsd: spend?.usd === null || spend?.usd === undefined ? null : Math.round(Number(spend.usd) * 100) / 100,
    refusals: ref,
    capDeferrals: n(deferrals?.n),
    gmailHealthy: health.gmailStatus === "active" || (lastSendAt !== null && Date.now() - lastSendAt.getTime() < GMAIL_LIVENESS_MS),
    capLimit: health.capLimit,
  };
}
