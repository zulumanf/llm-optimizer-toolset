/**
 * Prospecting cockpit reads (spec 095 → 098). One per-prospect facts query
 * over the ledgers, then pure derivations (lib/prospects/intent.ts). No
 * writes, no new persisted metrics — change the rules and every batch,
 * historical or live, re-derives the same way.
 *
 * Honesty rules baked into the queries:
 * - Contacted derives from ALLOWED SENDS in the ledger, never the
 *   `prospects.stage` column; stage drift is reported, not relied on.
 * - Audit views count only external, human-like traffic: internal QA opens,
 *   declared operator IPs, script user agents, and the mail-scanner window
 *   after each send are excluded. A dashboard that counts our own scripts
 *   as prospect interest lies to the operator.
 * - Email opens are an upper bound (mail-client prefetch); read-only
 *   diagnostics, never an intent input.
 */
import { sql } from "@/db/client";
import { GMAIL_DAILY_SEND_CAP, OUTREACH_LINK_PATTERN, type ProspectStage } from "@/lib/prospects/constants";
import {
  compareByPriority,
  deriveIntent,
  startOfOperatorDay,
  summarizeCohort,
  type AuditViewFact,
  type CohortSummary,
  type ProspectBehaviorFacts,
  type ProspectIntent,
} from "@/lib/prospects/intent";

/** Script/bot user agents recorded on audit views by our own QA sweeps and
 * crawlers. A NULL user agent is also treated as non-human. */
const SCRIPT_UA =
  "(curl|wget|python|node|undici|go-http|okhttp|bot|crawler|spider|headless|monitor|preview|slack|facebookexternalhit|whatsapp|telegram|claude|chatgpt|openai|anthropic|perplexity|gptbot|linkcheck|httpclient|java/|axios)";

/** Mail-provider link scanners fetch every URL in a delivered email within
 * seconds, wearing real-browser user agents (found live: audit "views" 7-40
 * seconds after each send, multiple IPs; QA 2026-08-21 found a same-IP pair
 * with two different OS user agents at 252 s and 326 s). A view inside this
 * window after a send to the same prospect is counted as a scan, not
 * interest — a human who clicks inside ten minutes is still caught by the
 * beacon-bearing sessions that follow. */
export const SCANNER_WINDOW_SECONDS = 600;

const operatorIps = (): string[] =>
  (process.env.INTERNAL_VIEW_IPS ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

/** External, human-like audit views — the subquery every view count uses. */
export const humanViews = () => sql`
  select v.id, v.audit_id, v.viewed_at, v.link_key, va.prospect_id
  from prospect_audit_views v
  join prospect_audits va on va.id = v.audit_id
  where not v.is_internal
    and v.user_agent is not null
    and v.user_agent !~* ${SCRIPT_UA}
    and (v.ip is null or v.ip != all(coalesce(string_to_array(nullif(${operatorIps().join(",")}, ''), ','), '{}'::text[])))
    and not exists (
      select 1 from prospect_outreach_sends s
      where s.prospect_id = va.prospect_id and s.allowed
        and v.viewed_at >= s.sent_at
        and v.viewed_at < s.sent_at + make_interval(secs => ${SCANNER_WINDOW_SECONDS})
    )
`;

export type Window = "today" | "7d" | "30d" | "batch";
export const WINDOWS: { key: Window; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
  { key: "batch", label: "Batch" },
];

export interface CockpitFilter {
  launchId?: string;
  window?: Window;
}

interface ViewRow {
  id: string;
  viewedAt: Date;
  linkKey: string | null;
  sessionId: string | null;
  visitorId: string | null;
  engagedSeconds: number;
  maxScroll: number;
  sections: string[];
  evidenceExpanded: boolean;
  ctaClicked: boolean;
}

/** Every unarchived prospect with its measured facts — views enriched with
 * the beacon's per-view aggregates. Sends/views are cut to `since` when a
 * window is set so "today" means today; the batch lens is all-time. */
export async function prospectFacts(filter: CockpitFilter = {}): Promise<ProspectBehaviorFacts[]> {
  const since = windowStart(filter.window ?? "batch");
  const rows = await sql`
    with human_views as (${humanViews()}),
    view_signals as (
      select e.view_id,
        min(e.session_id) as session_id,
        min(e.visitor_id) filter (where e.visitor_id is not null) as visitor_id,
        coalesce(max(e.value) filter (where e.kind = 'engaged_time'), 0) as engaged_seconds,
        coalesce(max(e.value) filter (where e.kind = 'scroll'), 0) as max_scroll,
        coalesce(array_agg(distinct e.target) filter (where e.kind = 'section_viewed' and e.target is not null), '{}') as sections,
        bool_or(e.kind = 'evidence_expanded') as evidence_expanded,
        bool_or(e.kind = 'cta_clicked') as cta_clicked
      from prospect_audit_engagement_events e
      group by e.view_id
    )
    select p.id, p.business_name, p.launch_id, l.name as launch_name, p.stage,
      coalesce(p.qualification_override, p.qualification_score) as quality_score,
      (p.email is not null or exists (select 1 from prospect_contacts c
        where c.prospect_id = p.id and c.archived_at is null
          and not c.do_not_contact and c.email is not null)) as has_email,
      exists (select 1 from prospect_audits a where a.prospect_id = p.id
        and a.status = 'published' and (a.expires_at is null or a.expires_at > now())) as audit_published,
      coalesce((select array_agg(h.to_stage) from prospect_stage_history h where h.prospect_id = p.id), '{}') as visited_stages,
      coalesce((select array_agg(s.sent_at order by s.sent_at) from prospect_outreach_sends s
        where s.prospect_id = p.id and s.allowed
          and (${since}::timestamptz is null or s.sent_at >= ${since})), '{}') as sent_ats,
      p.prospect_type,
      (select min(h.changed_at) from prospect_stage_history h where h.prospect_id = p.id
        and h.to_stage in ('replied','discovery_scheduled','discovery_completed','proposal_sent','negotiation','verbal_yes','contracted')) as replied_at,
      (select min(h.changed_at) from prospect_stage_history h where h.prospect_id = p.id
        and h.to_stage in ('discovery_scheduled','discovery_completed','proposal_sent','negotiation','verbal_yes','contracted')) as meeting_at,
      coalesce((select json_agg(json_build_object(
          'sentAt', s.sent_at, 'subject', d.subject, 'draftChannel', d.channel,
          'hasLink', (d.body ~* ${OUTREACH_LINK_PATTERN}),
          'templateVersion', d.prompt_version,
          'opens', (select count(*)::int from outreach_email_opens o where o.send_id = s.id),
          'bounced', exists (select 1 from suppression_entries se
            where se.lifted_at is null and se.reason ilike '%bounce%'
              and se.normalized_value = lower(s.recipient_email))) order by s.sent_at)
        from prospect_outreach_sends s left join outreach_drafts d on d.id = s.draft_id
        where s.prospect_id = p.id and s.allowed
          and (${since}::timestamptz is null or s.sent_at >= ${since})), '[]') as sends,
      (select count(*)::int from outreach_email_opens o
        join prospect_outreach_sends s on s.id = o.send_id
        where s.prospect_id = p.id
          and (${since}::timestamptz is null or o.opened_at >= ${since})) as opens,
      coalesce((select json_agg(json_build_object(
          'receivedAt', pr.received_at, 'classification', pr.classification)
          order by pr.received_at)
        from prospect_replies pr where pr.prospect_id = p.id
          and (${since}::timestamptz is null or pr.received_at >= ${since})), '[]') as replies,
      coalesce((select json_agg(json_build_object(
          'id', hv.id, 'viewedAt', hv.viewed_at, 'linkKey', hv.link_key,
          'sessionId', vs.session_id, 'visitorId', vs.visitor_id,
          'engagedSeconds', coalesce(vs.engaged_seconds, 0),
          'maxScroll', coalesce(vs.max_scroll, 0),
          'sections', coalesce(vs.sections, '{}'),
          'evidenceExpanded', coalesce(vs.evidence_expanded, false),
          'ctaClicked', coalesce(vs.cta_clicked, false)) order by hv.viewed_at)
        from human_views hv left join view_signals vs on vs.view_id = hv.id
        where hv.prospect_id = p.id
          and (${since}::timestamptz is null or hv.viewed_at >= ${since})), '[]') as views,
      -- Observed but not qualifying: external rows the human filter rejects
      -- (script UA, operator IP, mail-scanner window). Shown as fact, never
      -- used for intent.
      (select count(*)::int from prospect_audit_views v
        join prospect_audits a2 on a2.id = v.audit_id
        where a2.prospect_id = p.id and not v.is_internal
          and v.id not in (select id from human_views)
          and (${since}::timestamptz is null or v.viewed_at >= ${since})) as unqualified_views
    from prospects p
    join market_launches l on l.id = p.launch_id
    where p.archived_at is null
      and (${filter.launchId ?? null}::uuid is null or p.launch_id = ${filter.launchId ?? null})
  `;
  return rows.map((r) => ({
    prospectId: r.id as string,
    businessName: r.businessName as string,
    launchId: r.launchId as string,
    launchName: r.launchName as string,
    qualityScore: r.qualityScore === null ? null : Number(r.qualityScore),
    stage: r.stage as ProspectStage,
    visitedStages: (r.visitedStages as ProspectStage[]) ?? [],
    sentAts: ((r.sentAts as (Date | string)[]) ?? []).map((d) => new Date(d)),
    sends: ((r.sends as { sentAt: string; subject: string | null; draftChannel: string | null; opens: number; bounced: boolean; hasLink: boolean | null; templateVersion: string | null }[]) ?? []).map((x, i) => ({
      sentAt: new Date(x.sentAt),
      touch: i + 1,
      subject: x.subject ?? null,
      draftChannel: x.draftChannel ?? null,
      opens: Number(x.opens ?? 0),
      bounced: Boolean(x.bounced),
      hasLink: x.hasLink ?? null,
      templateVersion: x.templateVersion ?? null,
    })),
    replies: ((r.replies as { receivedAt: string; classification: string }[]) ?? []).map((x) => ({
      receivedAt: new Date(x.receivedAt),
      classification: x.classification,
    })),
    prospectType: (r.prospectType as string | null) ?? null,
    repliedAt: r.repliedAt ? new Date(r.repliedAt as Date) : null,
    meetingAt: r.meetingAt ? new Date(r.meetingAt as Date) : null,
    opens: Number(r.opens ?? 0),
    hasEmail: Boolean(r.hasEmail),
    unqualifiedViews: Number(r.unqualifiedViews ?? 0),
    auditPublished: Boolean(r.auditPublished),
    views: ((r.views as ViewRow[]) ?? []).map(
      (v): AuditViewFact => ({
        viewedAt: new Date(v.viewedAt),
        sessionId: v.sessionId ?? null,
        visitorId: v.visitorId ?? null,
        linkKey: v.linkKey ?? null,
        engagedSeconds: Number(v.engagedSeconds ?? 0),
        maxScrollPercent: Number(v.maxScroll ?? 0),
        sectionsViewed: v.sections ?? [],
        evidenceExpanded: Boolean(v.evidenceExpanded),
        ctaClicked: Boolean(v.ctaClicked),
      })
    ),
  }));
}

export function windowStart(window: Window, now: Date = new Date()): Date | null {
  if (window === "batch") return null;
  if (window === "today") return startOfOperatorDay(now);
  const days = window === "7d" ? 7 : 30;
  return new Date(now.getTime() - days * 86_400_000);
}

export interface CockpitLaunch {
  id: string;
  name: string;
  prospectCount: number;
  /** Prospects with ≥1 allowed send. */
  contactedCount: number;
  lastSentAt: Date | null;
}

export interface Cockpit {
  prospects: ProspectIntent[];
  cohort: CohortSummary;
  /** Contacted per the ledger but still recorded at a pre-contact stage. */
  stageDrift: number;
  launches: CockpitLaunch[];
  /** The cohort the operator is most likely working: the launch with the
   * most recent allowed send. Null when nothing has ever been sent. */
  activeLaunchId: string | null;
}

/** Most recently contacted launch wins — derived, never configured. */
export function pickActiveLaunch(launches: CockpitLaunch[]): string | null {
  const sent = launches.filter((l) => l.lastSentAt !== null);
  if (sent.length === 0) return null;
  return sent.sort((a, b) => b.lastSentAt!.getTime() - a.lastSentAt!.getTime())[0]!.id;
}

export async function cockpit(filter: CockpitFilter = {}, now: Date = new Date()): Promise<Cockpit> {
  const [facts, launchRows] = await Promise.all([
    prospectFacts(filter),
    sql`
      select l.id, l.name, count(p.id)::int as prospect_count,
        count(p.id) filter (where exists (select 1 from prospect_outreach_sends s
          where s.prospect_id = p.id and s.allowed))::int as contacted_count,
        (select max(s.sent_at) from prospect_outreach_sends s
          join prospects p2 on p2.id = s.prospect_id
          where p2.launch_id = l.id and s.allowed) as last_sent_at
      from market_launches l
      left join prospects p on p.launch_id = l.id and p.archived_at is null
      where l.archived_at is null
      group by l.id, l.name order by l.created_at desc
    `,
  ]);
  const launches: CockpitLaunch[] = launchRows.map((l) => ({
    id: l.id as string,
    name: l.name as string,
    prospectCount: Number(l.prospectCount ?? 0),
    contactedCount: Number(l.contactedCount ?? 0),
    lastSentAt: l.lastSentAt ? new Date(l.lastSentAt as Date) : null,
  }));
  const prospects = facts.map((f) => deriveIntent(f, now)).sort(compareByPriority);
  const preContact: readonly ProspectStage[] = ["identified", "researching", "benchmarking", "qualified", "outreach_ready"];
  return {
    prospects,
    cohort: summarizeCohort(prospects, now),
    stageDrift: prospects.filter((p) => p.sales.contacted && preContact.includes(p.stage)).length,
    launches,
    activeLaunchId: pickActiveLaunch(launches),
  };
}

export interface UpcomingSend {
  draftId: string;
  prospectId: string;
  businessName: string;
  launchId: string;
  subject: string | null;
  channel: string;
  /** Touch number = prior allowed sends + 1. */
  touch: number;
  scheduledAt: Date | null;
  /** approved + scheduled → the worker sends it; approved + unscheduled →
   * a human must press send; draft → approval required; parked → blocked. */
  state: "auto_send" | "manual_send" | "approval_required" | "blocked";
  error: string | null;
}

/** What the OS is about to do without the operator: approved drafts with a
 * send time, approved drafts waiting on a human, drafts awaiting approval,
 * and parked (blocked) sends. Read from outreach_drafts — no new tables. */
export async function upcomingAutomation(launchId?: string): Promise<UpcomingSend[]> {
  const rows = await sql`
    select d.id as draft_id, d.prospect_id, p.business_name, p.launch_id, d.subject, d.channel,
      d.scheduled_send_at, d.status, d.last_send_error,
      (select count(*)::int from prospect_outreach_sends s
        where s.prospect_id = p.id and s.allowed) as prior_sends
    from outreach_drafts d
    join prospects p on p.id = d.prospect_id
    where p.archived_at is null and d.sent_recorded_at is null
      and d.status in ('draft', 'approved')
      and (${launchId ?? null}::uuid is null or p.launch_id = ${launchId ?? null})
    order by d.scheduled_send_at asc nulls last, d.created_at asc
    limit 50
  `;
  return rows.map((r) => {
    const status = r.status as string;
    const parked = r.lastSendError !== null && r.scheduledSendAt === null;
    const state: UpcomingSend["state"] =
      status === "draft"
        ? "approval_required"
        : parked
          ? "blocked"
          : r.scheduledSendAt
            ? "auto_send"
            : "manual_send";
    return {
      draftId: r.draftId as string,
      prospectId: r.prospectId as string,
      businessName: r.businessName as string,
      launchId: r.launchId as string,
      subject: (r.subject as string | null) ?? null,
      channel: r.channel as string,
      touch: Number(r.priorSends ?? 0) + 1,
      scheduledAt: r.scheduledSendAt ? new Date(r.scheduledSendAt as Date) : null,
      state,
      error: (r.lastSendError as string | null) ?? null,
    };
  });
}

/** Facts + derivations for one prospect (detail page). */
export async function prospectIntent(prospectId: string, now: Date = new Date()): Promise<ProspectIntent | null> {
  const [row] = await sql`select launch_id from prospects where id = ${prospectId}`;
  if (!row) return null;
  const facts = await prospectFacts({ launchId: row.launchId as string });
  const f = facts.find((x) => x.prospectId === prospectId);
  return f ? deriveIntent(f, now) : null;
}

export interface TimelineEvent {
  at: Date;
  kind: "sent" | "view" | "scroll" | "engaged" | "section" | "evidence" | "cta" | "stage";
  label: string;
}

/** Merged evidence timeline for one prospect: sends, qualifying views
 * (pre/post outreach labeled), beacon milestones, stage changes. */
export async function prospectTimeline(prospectId: string): Promise<TimelineEvent[]> {
  const rows = await sql`
    with human_views as (${humanViews()})
    select 'sent' as kind, s.sent_at as at, null::text as target, null::int as value, null::text as session_id
      from prospect_outreach_sends s where s.prospect_id = ${prospectId} and s.allowed
    union all
    select 'view', hv.viewed_at, hv.link_key, null, null from human_views hv where hv.prospect_id = ${prospectId}
    union all
    select e.kind, e.occurred_at, e.target, e.value, e.session_id
      from prospect_audit_engagement_events e
      join human_views hv on hv.id = e.view_id
      where hv.prospect_id = ${prospectId} and e.kind <> 'engaged_time'
    union all
    select 'stage', h.changed_at, h.to_stage, null, null
      from prospect_stage_history h where h.prospect_id = ${prospectId}
    order by at asc
  `;
  const firstSend = rows.find((r) => r.kind === "sent")?.at as Date | undefined;
  let firstPostView = false;
  const seenScroll = new Set<string>();
  const events: TimelineEvent[] = [];
  for (const r of rows) {
    const at = new Date(r.at as Date);
    const kind = r.kind as string;
    if (kind === "sent") events.push({ at, kind: "sent", label: "Email sent" });
    else if (kind === "view") {
      const post = firstSend !== undefined && at >= firstSend;
      let label = post ? "Audit visit" : "Audit visit (before outreach)";
      if (post && !firstPostView) {
        firstPostView = true;
        label = "First qualifying post-outreach audit visit";
      } else if (post) label = "Repeat audit session";
      if (r.target) label += " · via emailed link";
      events.push({ at, kind: "view", label });
    } else if (kind === "scroll") {
      const key = `${r.sessionId}:${r.value}`;
      if (seenScroll.has(key)) continue;
      seenScroll.add(key);
      events.push({ at, kind: "scroll", label: `Reached ${r.value}% depth` });
    } else if (kind === "section_viewed") events.push({ at, kind: "section", label: `Viewed ${String(r.target).replaceAll("_", " ")} section` });
    else if (kind === "evidence_expanded") events.push({ at, kind: "evidence", label: "Expanded supporting evidence" });
    else if (kind === "cta_clicked") events.push({ at, kind: "cta", label: "Clicked the call to action" });
    else if (kind === "stage") events.push({ at, kind: "stage", label: `Stage → ${String(r.target).replaceAll("_", " ")}` });
  }
  return events;
}

export interface MachineHealth {
  capUsed24h: number;
  capLimit: number;
  gmailStatus: string | null;
  scheduledPending: number;
  activeSuppressions: number;
  parkedSends: { prospectId: string; businessName: string; error: string }[];
  draftsAwaitingApproval: number;
  expiringAudits: { prospectId: string; businessName: string; expiresAt: Date }[];
  /** Published audit, no contact email — the research/enrichment queue,
   * highest quality first. */
  researchQueue: { prospectId: string; businessName: string; qualityScore: number | null }[];
}

export async function machineHealth(): Promise<MachineHealth> {
  // Sequential on purpose: five concurrent queries per page load tripped
  // the pooler's session cap (EMAXCONNSESSION) alongside the worker.
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
  const parked = await sql`
      select p.id as prospect_id, p.business_name, d.last_send_error as error
      from outreach_drafts d join prospects p on p.id = d.prospect_id
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
  const expiring = await sql`
      select p.id as prospect_id, p.business_name, a.expires_at
      from prospect_audits a join prospects p on p.id = a.prospect_id
      where a.status = 'published' and p.archived_at is null
        and a.expires_at between now() and now() + interval '7 days'
      order by a.expires_at asc limit 10
    `;
  const research = await sql`
      select p.id as prospect_id, p.business_name,
        coalesce(p.qualification_override, p.qualification_score) as quality_score
      from prospects p
      where p.archived_at is null and p.email is null
        and exists (select 1 from prospect_audits a
          where a.prospect_id = p.id and a.status = 'published')
        and not exists (select 1 from prospect_contacts c
          where c.prospect_id = p.id and c.archived_at is null
            and not c.do_not_contact and c.email is not null)
      order by coalesce(p.qualification_override, p.qualification_score) desc nulls last, p.business_name
    `;
  return {
    capUsed24h: Number(row?.capUsed ?? 0),
    capLimit: GMAIL_DAILY_SEND_CAP,
    gmailStatus: (row?.gmailStatus as string | null) ?? null,
    scheduledPending: Number(row?.scheduledPending ?? 0),
    activeSuppressions: Number(row?.suppressions ?? 0),
    parkedSends: parked.map((r) => ({
      prospectId: r.prospectId as string,
      businessName: r.businessName as string,
      error: (r.error as string) ?? "",
    })),
    draftsAwaitingApproval: Number(draftCount?.n ?? 0),
    expiringAudits: expiring.map((r) => ({
      prospectId: r.prospectId as string,
      businessName: r.businessName as string,
      expiresAt: r.expiresAt as Date,
    })),
    researchQueue: research.map((r) => ({
      prospectId: r.prospectId as string,
      businessName: r.businessName as string,
      qualityScore: r.qualityScore === null ? null : Number(r.qualityScore),
    })),
  };
}
