/**
 * Read model for the prospect detail page (spec 032). Server-only queries —
 * staff access is enforced by the /prospects segment layout; nothing here is
 * imported by portal code.
 */
import "server-only";
import { sql } from "@/db/client";
import type { AuditSnapshot } from "@/lib/prospects/service";

export interface ProspectDetail {
  id: string;
  launchId: string;
  launchName: string;
  marketName: string;
  businessName: string;
  prospectType: string;
  companyId: string | null;
  companyName: string | null;
  brokerageAffiliation: string | null;
  teamLeader: string | null;
  website: string | null;
  email: string | null;
  phone: string | null;
  priceSegment: string | null;
  estTransactionVolumeUsd: number | null;
  estTeamSize: number | null;
  source: string;
  fieldProvenance: Record<string, string>;
  ownerName: string | null;
  qualificationScore: number | null;
  qualificationBreakdown: Record<string, unknown> | null;
  qualificationOverride: number | null;
  qualificationOverrideReason: string | null;
  relationshipStrength: string;
  stage: string;
  promotedProjectId: string | null;
  nextAction: string | null;
  nextActionOn: string | null;
  doNotContact: boolean;
  doNotContactReason: string | null;
  conflictStatus: string;
  notes: string | null;
  benchmarkProjectId: string | null;
}

export async function getProspectDetail(id: string): Promise<ProspectDetail | null> {
  const rows = await sql`
    select p.id, p.launch_id, l.name as launch_name, m.name as market_name,
      p.business_name, p.prospect_type, p.company_id, c.name as company_name,
      p.brokerage_affiliation, p.team_leader, p.website, p.email, p.phone,
      p.price_segment, p.est_transaction_volume_usd, p.est_team_size, p.source,
      p.field_provenance, u.name as owner_name, p.qualification_score,
      p.qualification_breakdown, p.qualification_override,
      p.qualification_override_reason,
      p.relationship_strength, p.stage, p.next_action, p.next_action_on::text,
      p.do_not_contact, p.do_not_contact_reason, p.conflict_status, p.notes,
      p.benchmark_project_id, p.promoted_project_id
    from prospects p
    join market_launches l on l.id = p.launch_id
    join markets m on m.id = l.market_id
    left join companies c on c.id = p.company_id
    left join users u on u.id = p.owner_id
    where p.id = ${id} and p.archived_at is null
  `;
  return (rows[0] as unknown as ProspectDetail) ?? null;
}

export interface SignalRow {
  id: string;
  kind: string;
  label: string;
  valueText: string | null;
  sourceUrl: string | null;
  provenance: string;
  confidence: number | null;
  scope: string;
  /** retrieved_at when recorded, else created_at — the freshness base. */
  observedAt: Date;
}

export async function listSignals(prospectId: string): Promise<SignalRow[]> {
  return sql<SignalRow[]>`
    select id, kind, label, value_text, source_url, provenance, confidence,
      scope, coalesce(retrieved_at, created_at) as observed_at
    from prospect_authority_signals
    where prospect_id = ${prospectId}
    order by created_at asc
  `;
}

export interface AssessmentRow {
  item: string;
  value: string;
  note: string | null;
  recordedAt: Date;
}

export async function listAssessments(prospectId: string): Promise<AssessmentRow[]> {
  return sql<AssessmentRow[]>`
    select item, value, note, recorded_at
    from prospect_assessments
    where prospect_id = ${prospectId}
    order by item asc
  `;
}

export interface ContactRow {
  id: string;
  name: string;
  role: string | null;
  email: string | null;
  phone: string | null;
  linkedin: string | null;
  preferredChannel: string | null;
  isPrimary: boolean;
  doNotContact: boolean;
  doNotContactReason: string | null;
  provenance: string;
  notes: string | null;
}

export async function listContacts(prospectId: string): Promise<ContactRow[]> {
  return sql<ContactRow[]>`
    select id, name, role, email, phone, linkedin, preferred_channel,
      is_primary, do_not_contact, do_not_contact_reason, provenance, notes
    from prospect_contacts
    where prospect_id = ${prospectId} and archived_at is null
    order by is_primary desc, created_at asc
  `;
}

export interface BenchmarkListRow {
  id: string;
  runId: string;
  runLabel: string;
  runStatus: string;
  runStartedAt: Date;
  createdAt: Date;
}

export async function listBenchmarks(prospectId: string): Promise<BenchmarkListRow[]> {
  return sql<BenchmarkListRow[]>`
    select b.id, b.run_id, r.label as run_label, r.status as run_status,
      r.started_at as run_started_at, b.created_at
    from prospect_benchmarks b join runs r on r.id = b.run_id
    where b.prospect_id = ${prospectId}
    order by b.created_at desc
  `;
}

export interface FindingRow {
  id: string;
  benchmarkId: string;
  kind: string;
  title: string;
  explanation: string;
  responseIds: string[];
  signalIds: string[];
  confidence: number | null;
  severity: string;
  rankScore: number | null;
  status: string;
  isPrimary: boolean;
  suggestedAngle: string | null;
}

export async function listFindings(prospectId: string): Promise<FindingRow[]> {
  return sql<FindingRow[]>`
    select id, benchmark_id, kind, title, explanation, response_ids, signal_ids,
      confidence, severity, rank_score, status, is_primary, suggested_angle
    from prospect_findings
    where prospect_id = ${prospectId} and status != 'archived'
    order by rank_score desc nulls last, created_at desc
  `;
}

export interface AuditRow {
  id: string;
  headline: string;
  status: string;
  accessToken: string | null;
  expiresAt: Date | null;
  publishedAt: Date | null;
  viewCount: number;
  firstViewedAt: Date | null;
  lastViewedAt: Date | null;
  snapshot: AuditSnapshot;
}

export async function listAudits(prospectId: string): Promise<AuditRow[]> {
  const rows = await sql`
    select a.id, a.headline, a.status, a.access_token, a.expires_at,
      a.published_at, a.snapshot,
      (select count(*)::int from prospect_audit_views v
        where v.audit_id = a.id and not v.is_internal) as view_count,
      (select min(v.viewed_at) from prospect_audit_views v
        where v.audit_id = a.id and not v.is_internal) as first_viewed_at,
      (select max(v.viewed_at) from prospect_audit_views v
        where v.audit_id = a.id and not v.is_internal) as last_viewed_at
    from prospect_audits a
    where a.prospect_id = ${prospectId}
    order by a.created_at desc
  `;
  return rows as unknown as AuditRow[];
}

export interface DraftRow {
  id: string;
  channel: string;
  version: number;
  subject: string | null;
  body: string;
  cta: string | null;
  generatedBy: string;
  status: string;
  approvedAt: Date | null;
  sentRecordedAt: Date | null;
  scheduledSendAt: Date | null;
  lastSendError: string | null;
  contactId: string | null;
  contactName: string | null;
  contactEmail: string | null;
  /** Whether any allowed send of this draft carried an open-tracking pixel
   * (spec 092). False renders as "not tracked", never as zero opens. */
  openTracked: boolean;
  openCount: number;
  lastOpenedAt: Date | null;
}

export async function listDrafts(prospectId: string): Promise<DraftRow[]> {
  return sql<DraftRow[]>`
    select d.id, d.channel, d.version, d.subject, d.body, d.cta, d.generated_by,
      d.status, d.approved_at, d.sent_recorded_at, d.scheduled_send_at,
      d.last_send_error, d.contact_id,
      c.name as contact_name, c.email as contact_email,
      coalesce(o.open_tracked, false) as open_tracked,
      coalesce(o.open_count, 0) as open_count,
      o.last_opened_at
    from outreach_drafts d
    left join prospect_contacts c on c.id = d.contact_id
    left join lateral (
      select bool_or(s.open_token is not null) as open_tracked,
        count(op.id)::int as open_count,
        max(op.opened_at) as last_opened_at
      from prospect_outreach_sends s
      left join outreach_email_opens op on op.send_id = s.id
      where s.draft_id = d.id and s.allowed
    ) o on true
    where d.prospect_id = ${prospectId}
    order by d.channel asc, d.version desc
  `;
}

export interface RecordingPlanRow {
  id: string;
  script: string;
  status: string;
  estimatedDurationSeconds: number | null;
  claimsToVerify: string[];
  cta: string | null;
  createdAt: Date;
}

export async function listRecordingPlans(prospectId: string): Promise<RecordingPlanRow[]> {
  const rows = await sql`
    select id, script, status, estimated_duration_seconds, claims_to_verify,
      cta, created_at
    from screen_recording_plans
    where prospect_id = ${prospectId}
    order by created_at desc
  `;
  return rows as unknown as RecordingPlanRow[];
}

export interface StageHistoryRow {
  id: string;
  fromStage: string;
  toStage: string;
  reason: string | null;
  changedByName: string | null;
  changedAt: Date;
}

export async function listStageHistory(prospectId: string): Promise<StageHistoryRow[]> {
  return sql<StageHistoryRow[]>`
    select h.id, h.from_stage, h.to_stage, h.reason, u.name as changed_by_name,
      h.changed_at
    from prospect_stage_history h left join users u on u.id = h.changed_by
    where h.prospect_id = ${prospectId}
    order by h.changed_at desc
    limit 50
  `;
}

export interface ActivityRow {
  id: string;
  kind: string;
  detail: Record<string, unknown>;
  actorName: string | null;
  occurredAt: Date;
}

export async function listActivities(prospectId: string): Promise<ActivityRow[]> {
  return sql<ActivityRow[]>`
    select a.id, a.kind, a.detail, u.name as actor_name, a.occurred_at
    from prospect_activities a left join users u on u.id = a.actor_id
    where a.prospect_id = ${prospectId}
    order by a.occurred_at desc
    limit 100
  `;
}

export interface LinkableRun {
  id: string;
  label: string;
  projectName: string;
  status: string;
  startedAt: Date;
}

/** Completed/partial runs where the prospect's company has scores. */
export async function linkableRuns(companyId: string): Promise<LinkableRun[]> {
  return sql<LinkableRun[]>`
    select distinct r.id, r.label, p.name as project_name, r.status, r.started_at
    from runs r
    join projects p on p.id = r.project_id
    join scores s on s.run_id = r.id and s.company_id = ${companyId}
    where r.status in ('completed', 'partial')
    order by r.started_at desc
    limit 25
  `;
}
