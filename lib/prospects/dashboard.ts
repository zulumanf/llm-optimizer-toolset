/**
 * Prospecting dashboard reads (spec 095). The operator's morning screen:
 * what happened, who to act on, how the funnel looks, is the machine
 * healthy. Read-only aggregations — no new tables, no writes.
 *
 * Honesty rules baked into the queries:
 * - The funnel derives from MEASURED events (send ledger, opens, views,
 *   stage history), never the `prospects.stage` column — recorded stages
 *   lag reality, and that drift is itself surfaced as an action item.
 * - Audit views count only external, human-like traffic: internal QA opens
 *   and script user agents (curl/node/python/bots — our own sweeps) are
 *   excluded. A dashboard that counts our scripts as prospect interest
 *   lies to the operator.
 * - Email opens are an upper bound (mail-client prefetch); the page labels
 *   them so.
 */
import { sql } from "@/db/client";
import { GMAIL_DAILY_SEND_CAP } from "@/lib/prospects/constants";

/** Script/bot user agents recorded on audit views by our own QA sweeps and
 * crawlers. A NULL user agent is also treated as non-human. */
const SCRIPT_UA =
  "(curl|wget|python|node|undici|go-http|okhttp|bot|crawler|spider|headless|monitor)";

export interface EngagementNow {
  opens24h: number;
  opensTotal: number;
  /** Distinct prospects with at least one open. */
  openedProspects: number;
  views24h: number;
  viewsTotal: number;
  viewedProspects: number;
  repliesRecorded: number;
  lastEventAt: Date | null;
}

export interface FunnelStep {
  key: string;
  label: string;
  count: number;
  /** Where this number comes from — shown to the operator. */
  basis: string;
}

export interface HotProspect {
  prospectId: string;
  businessName: string;
  views: number;
  lastViewAt: Date;
  opens: number;
  lastSentAt: Date | null;
}

export interface StalledProspect {
  prospectId: string;
  businessName: string;
  lastSentAt: Date;
  daysSinceSend: number;
}

export interface ActionQueues {
  hot: HotProspect[];
  stalled: StalledProspect[];
  parkedSends: { prospectId: string; businessName: string; error: string }[];
  draftsAwaitingApproval: number;
  missingEmail: { prospectId: string; businessName: string }[];
  expiringAudits: { prospectId: string; businessName: string; expiresAt: Date }[];
  /** Contacted per the ledger but still recorded at an earlier stage. */
  stageDrift: number;
}

export interface MachineHealth {
  capUsed24h: number;
  capLimit: number;
  gmailStatus: string | null;
  scheduledPending: number;
  activeSuppressions: number;
}

/** External, human-like audit views — the subquery every view count uses. */
const HUMAN_VIEWS = sql`
  select v.audit_id, v.viewed_at from prospect_audit_views v
  where not v.is_internal
    and v.user_agent is not null
    and v.user_agent !~* ${SCRIPT_UA}
`;

export async function engagementNow(): Promise<EngagementNow> {
  const [row] = await sql`
    with human_views as (${HUMAN_VIEWS})
    select
      (select count(*)::int from outreach_email_opens where opened_at > now() - interval '24 hours') as opens24h,
      (select count(*)::int from outreach_email_opens) as opens_total,
      (select count(distinct s.prospect_id)::int from outreach_email_opens o
        join prospect_outreach_sends s on s.id = o.send_id) as opened_prospects,
      (select count(*)::int from human_views where viewed_at > now() - interval '24 hours') as views24h,
      (select count(*)::int from human_views) as views_total,
      (select count(distinct a.prospect_id)::int from human_views hv
        join prospect_audits a on a.id = hv.audit_id) as viewed_prospects,
      (select count(distinct prospect_id)::int from prospect_stage_history
        where to_stage in ('replied','audit_viewed','discovery_scheduled','discovery_completed',
          'proposal_sent','negotiation','verbal_yes','contracted')) as replies_recorded,
      greatest(
        (select max(opened_at) from outreach_email_opens),
        (select max(viewed_at) from human_views)
      ) as last_event_at
  `;
  return {
    opens24h: Number(row?.opens24h ?? 0),
    opensTotal: Number(row?.opensTotal ?? 0),
    openedProspects: Number(row?.openedProspects ?? 0),
    views24h: Number(row?.views24h ?? 0),
    viewsTotal: Number(row?.viewsTotal ?? 0),
    viewedProspects: Number(row?.viewedProspects ?? 0),
    repliesRecorded: Number(row?.repliesRecorded ?? 0),
    lastEventAt: (row?.lastEventAt as Date | null) ?? null,
  };
}

export async function eventFunnel(): Promise<FunnelStep[]> {
  const [row] = await sql`
    with human_views as (${HUMAN_VIEWS})
    select
      (select count(*)::int from prospects where archived_at is null) as prospects,
      (select count(distinct a.prospect_id)::int from prospect_audits a
        join prospects p on p.id = a.prospect_id
        where a.status = 'published' and p.archived_at is null
          and (a.expires_at is null or a.expires_at > now())) as published,
      (select count(distinct s.prospect_id)::int from prospect_outreach_sends s
        join prospects p on p.id = s.prospect_id
        where s.allowed and p.archived_at is null) as contacted,
      (select count(distinct s.prospect_id)::int from outreach_email_opens o
        join prospect_outreach_sends s on s.id = o.send_id) as opened,
      (select count(distinct a.prospect_id)::int from human_views hv
        join prospect_audits a on a.id = hv.audit_id
        join prospect_outreach_sends s on s.prospect_id = a.prospect_id and s.allowed
      ) as viewed,
      (select count(distinct prospect_id)::int from prospect_stage_history
        where to_stage in ('replied','audit_viewed','discovery_scheduled','discovery_completed',
          'proposal_sent','negotiation','verbal_yes','contracted')) as replied,
      (select count(distinct prospect_id)::int from prospect_stage_history
        where to_stage in ('discovery_scheduled','discovery_completed','proposal_sent',
          'negotiation','verbal_yes','contracted')) as meetings,
      (select count(distinct prospect_id)::int from prospect_stage_history
        where to_stage = 'contracted') as contracted
  `;
  const n = (v: unknown): number => Number(v ?? 0);
  return [
    { key: "prospects", label: "Active prospects", count: n(row?.prospects), basis: "prospects, unarchived" },
    { key: "published", label: "Audit published", count: n(row?.published), basis: "published, unexpired audits" },
    { key: "contacted", label: "Contacted", count: n(row?.contacted), basis: "allowed sends in the ledger" },
    { key: "opened", label: "Email opened", count: n(row?.opened), basis: "open events — upper bound" },
    { key: "viewed", label: "Audit viewed", count: n(row?.viewed), basis: "human-like external views, contacted prospects" },
    { key: "replied", label: "Replied", count: n(row?.replied), basis: "recorded stage history" },
    { key: "meetings", label: "Meeting+", count: n(row?.meetings), basis: "recorded stage history" },
    { key: "contracted", label: "Contracted", count: n(row?.contracted), basis: "recorded stage history" },
  ];
}

export async function actionQueues(): Promise<ActionQueues> {
  const hot = await sql`
    with human_views as (${HUMAN_VIEWS})
    select p.id as prospect_id, p.business_name,
      count(hv.audit_id)::int as views, max(hv.viewed_at) as last_view_at,
      (select count(o.id)::int from outreach_email_opens o
        join prospect_outreach_sends s on s.id = o.send_id
        where s.prospect_id = p.id) as opens,
      (select max(s.sent_at) from prospect_outreach_sends s
        where s.prospect_id = p.id and s.allowed) as last_sent_at
    from human_views hv
    join prospect_audits a on a.id = hv.audit_id
    join prospects p on p.id = a.prospect_id
    where p.archived_at is null and hv.viewed_at > now() - interval '7 days'
    group by p.id, p.business_name
    order by max(hv.viewed_at) desc
    limit 8
  `;
  const stalled = await sql`
    with human_views as (${HUMAN_VIEWS})
    select p.id as prospect_id, p.business_name, max(s.sent_at) as last_sent_at,
      floor(extract(epoch from (now() - max(s.sent_at))) / 86400)::int as days_since_send
    from prospect_outreach_sends s
    join prospects p on p.id = s.prospect_id
    where s.allowed and p.archived_at is null
    group by p.id, p.business_name
    having max(s.sent_at) < now() - interval '3 days'
      and not exists (select 1 from outreach_email_opens o
        join prospect_outreach_sends s2 on s2.id = o.send_id where s2.prospect_id = p.id)
      and not exists (select 1 from human_views hv
        join prospect_audits a on a.id = hv.audit_id where a.prospect_id = p.id)
    order by max(s.sent_at) asc
    limit 8
  `;
  const parked = await sql`
    select p.id as prospect_id, p.business_name, d.last_send_error as error
    from outreach_drafts d
    join prospects p on p.id = d.prospect_id
    where d.status = 'approved' and d.sent_recorded_at is null
      and d.last_send_error is not null and d.scheduled_send_at is null
      and p.archived_at is null
    limit 8
  `;
  const [draftCount] = await sql`
    select count(*)::int as n from outreach_drafts d
    join prospects p on p.id = d.prospect_id
    where d.status = 'draft' and p.archived_at is null
  `;
  const missing = await sql`
    select p.id as prospect_id, p.business_name
    from prospects p
    where p.archived_at is null and p.email is null
      and exists (select 1 from prospect_audits a
        where a.prospect_id = p.id and a.status = 'published')
      and not exists (select 1 from prospect_contacts c
        where c.prospect_id = p.id and c.archived_at is null
          and not c.do_not_contact and c.email is not null)
    order by p.business_name
  `;
  const expiring = await sql`
    select p.id as prospect_id, p.business_name, a.expires_at
    from prospect_audits a
    join prospects p on p.id = a.prospect_id
    where a.status = 'published' and p.archived_at is null
      and a.expires_at is not null
      and a.expires_at between now() and now() + interval '7 days'
    order by a.expires_at asc
    limit 10
  `;
  const [drift] = await sql`
    select count(distinct s.prospect_id)::int as n
    from prospect_outreach_sends s
    join prospects p on p.id = s.prospect_id
    where s.allowed and p.archived_at is null
      and p.stage in ('identified','researching','benchmarking','qualified','outreach_ready')
  `;
  return {
    hot: hot.map((r) => ({
      prospectId: r.prospectId as string,
      businessName: r.businessName as string,
      views: Number(r.views),
      lastViewAt: r.lastViewAt as Date,
      opens: Number(r.opens),
      lastSentAt: (r.lastSentAt as Date | null) ?? null,
    })),
    stalled: stalled.map((r) => ({
      prospectId: r.prospectId as string,
      businessName: r.businessName as string,
      lastSentAt: r.lastSentAt as Date,
      daysSinceSend: Number(r.daysSinceSend),
    })),
    parkedSends: parked.map((r) => ({
      prospectId: r.prospectId as string,
      businessName: r.businessName as string,
      error: (r.error as string) ?? "",
    })),
    draftsAwaitingApproval: Number(draftCount?.n ?? 0),
    missingEmail: missing.map((r) => ({
      prospectId: r.prospectId as string,
      businessName: r.businessName as string,
    })),
    expiringAudits: expiring.map((r) => ({
      prospectId: r.prospectId as string,
      businessName: r.businessName as string,
      expiresAt: r.expiresAt as Date,
    })),
    stageDrift: Number(drift?.n ?? 0),
  };
}

export async function machineHealth(): Promise<MachineHealth> {
  const [row] = await sql`
    select
      (select count(*)::int from prospect_outreach_sends
        where channel = 'gmail' and allowed and sent_at > now() - interval '24 hours') as cap_used,
      (select status from connector_connections
        where provider = 'gmail' and revoked_at is null
        order by created_at desc limit 1) as gmail_status,
      (select count(*)::int from outreach_drafts
        where status = 'approved' and sent_recorded_at is null
          and scheduled_send_at is not null) as scheduled_pending,
      (select count(*)::int from suppression_entries where lifted_at is null) as suppressions
  `;
  return {
    capUsed24h: Number(row?.capUsed ?? 0),
    capLimit: GMAIL_DAILY_SEND_CAP,
    gmailStatus: (row?.gmailStatus as string | null) ?? null,
    scheduledPending: Number(row?.scheduledPending ?? 0),
    activeSuppressions: Number(row?.suppressions ?? 0),
  };
}
