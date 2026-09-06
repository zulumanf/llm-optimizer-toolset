/**
 * Portfolio QA and the client delivery orchestrator (spec 132).
 *
 * One batched read of every live engagement (a fixed handful of queries, not
 * N×12), assembled into the same overview the engagement page shows, then the
 * deterministic lanes (lib/engagements/qa.ts) derive alerts, QA status, loop
 * position, billing state and the single next action per client. Material
 * outcomes persist as engagement_qa_events (open → resolved/overridden);
 * PASS is never logged. Nothing here is a second source of truth: every
 * number comes from canonical rows and every rule is in qa.ts / rules.ts.
 */
import { z } from "zod";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { assertRole, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { firstZodMessage } from "@/lib/service-helpers";
import { geoRelation, type MarketNode } from "@/lib/exclusivity/detect";
import { RESOLVER_POLICY_VERSION } from "@/lib/engagements/constants";
import {
  commercialGate,
  composeWeeklyUpdate,
  deriveRenewalStatus,
  deriveStage,
  healthSignals,
  nextAction,
  onboardingChecklist,
  onboardingComplete,
  todayIso,
  type ChecklistItem,
  type MeasurementComparability,
  type MeasurementComparison,
  type MeasurementSnapshot,
} from "@/lib/engagements/rules";
import {
  activationQa,
  billingState,
  communicationQa,
  evidenceDriftQa,
  loopPosition,
  offboardingQa,
  portfolioAlerts,
  qaStatusFor,
  waitingOnSummary,
  type BillingState,
  type CommunicationFactPack,
  type LoopPosition,
  type PortfolioAlert,
  type QaIssue,
  type QaLane,
  type QaSeverity,
  type QaStatus,
  type QaVerdict,
  type WaitingOn,
} from "@/lib/engagements/qa";
import {
  ENGAGEMENT_SELECT,
  mapEngagementRow,
  type BillingSummary,
  type ChangeLogEntry,
  type ContextItem,
  type EngagementOverview,
  type EngagementRow,
  type MeasurementRow,
  type WorkItemView,
} from "@/lib/engagements/service";
import { onboardingQuestions, type OnboardingQuestion } from "@/lib/engagements/onboarding-questions";
import { buildMeasurementSnapshot } from "@/lib/engagements/measurement";

const LIVE = ["signed", "onboarding", "active", "renewal_review"] as const;
/** Closed engagements stay in the scan this long so an incomplete offboarding is seen. */
const OFFBOARDING_WATCH_DAYS = 45;
/** Daily windows for the periodic lanes. */
const PORTFOLIO_SCAN_WINDOW_HOURS = 20;

const toIso = (d: unknown): string => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d));

/** Production runs behind a session-mode pooler with a small client cap
 * (15 on Supabase); a 15-way Promise.all from one process can exhaust it.
 * The loader runs its fixed query set a few at a time instead. */
const LOADER_CONCURRENCY = 4;

async function inBatches<T>(thunks: (() => Promise<T>)[], size = LOADER_CONCURRENCY): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < thunks.length; i += size) {
    const chunk = thunks.slice(i, i + size);
    out.push(...(await Promise.all(chunk.map((fn) => fn()))));
  }
  return out;
}

/** Opt-in short cache so one page load (Today: feed + queue + section) scans once. */
const SCAN_CACHE_MS = 15_000;
const scanCache = new Map<string, { at: number; scan: PortfolioScan }>();

// ------------------------------------------------------------ batched load

interface PortfolioData {
  engagements: EngagementRow[];
  projectNames: Map<string, string>;
  subjects: Map<string, { id: string; name: string; aliases: string[] }>;
  competitors: Map<string, { companyId: string; name: string; archived: boolean }[]>;
  tasks: Map<string, WorkItemView[]>;
  context: Map<string, ContextItem[]>;
  measurements: Map<string, MeasurementRow[]>;
  billing: Map<string, BillingSummary["events"]>;
  lastUpdate: Map<string, { at: Date; channel: string; summary: string }>;
  grants: Map<string, number>;
  qaEvents: Map<string, QaIssue[]>;
  interventions: Map<string, ChangeLogEntry[]>;
  content: Map<string, ChangeLogEntry[]>;
  prospects: Map<string, { doNotContact: boolean }>;
  markets: MarketNode[];
  triggerPresent: boolean;
}

function group<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const arr = m.get(k) ?? [];
    arr.push(r);
    m.set(k, arr);
  }
  return m;
}

async function loadEngagements(filter: { projectId?: string; includeRecentlyClosed: boolean }, now: Date): Promise<EngagementRow[]> {
  const since = new Date(now.getTime() - OFFBOARDING_WATCH_DAYS * 86_400_000);
  const rows = filter.projectId
    ? await sql`
        ${ENGAGEMENT_SELECT}
        where e.project_id = ${filter.projectId}
        order by (e.stage in ('signed','onboarding','active','renewal_review')) desc, e.created_at desc
        limit 1
      `
    : await sql`
        ${ENGAGEMENT_SELECT}
        where (e.stage in ('signed','onboarding','active','renewal_review')
          ${filter.includeRecentlyClosed ? sql`or (e.stage in ('completed','churned') and e.closed_at >= ${since})` : sql``})
          -- An archived project has left the operating portfolio (fixtures, retired clients).
          and exists (select 1 from projects p where p.id = e.project_id and p.status = 'active')
        order by e.starts_on asc
      `;
  return rows.map(mapEngagementRow);
}

async function loadPortfolioData(engagements: EngagementRow[]): Promise<PortfolioData> {
  const projectIds = [...new Set(engagements.map((e) => e.projectId))];
  const engagementIds = engagements.map((e) => e.id);
  const contractRefs = engagementIds.map((id) => `engagement:${id}`);
  const prospectIds = engagements.map((e) => e.prospectId).filter((x): x is string => Boolean(x));
  const [projects, subjects, competitors, tasks, context, measurements, billing, updates, grants, qaEvents, interventions, content, prospects, markets, trigger] = (await inBatches<Record<string, unknown>[]>([
    () => sql`select id, name from projects where id = any(${projectIds}::uuid[])`,
    () => sql`select p.id as project_id, c.id, c.name, c.aliases from projects p join companies c on c.id = p.subject_company_id where p.id = any(${projectIds}::uuid[])`,
    () => sql`select k.project_id, c.id as company_id, c.name, (c.archived_at is not null or c.merged_into is not null) as archived
        from competitors k join companies c on c.id = k.company_id
        where k.project_id = any(${projectIds}::uuid[]) and k.archived_at is null`,
    () => sql`select id, project_id, title, status, priority, client_visible, observation, hypothesis, confidence, control, scope,
          client_approval, blocked_reason, blocked_note, target_url, before_state, after_state, implemented_at,
          due_date, updated_at, cardinality(evidence_ids) as evidence_count
        from tasks where project_id = any(${projectIds}::uuid[])
        order by (status = 'in_progress') desc, (status = 'approved') desc, (status = 'suggested') desc, updated_at desc`,
    () => sql`select id, engagement_id, kind, label, value, provenance, access_status, source_ref, created_at
        from engagement_context_items where engagement_id = any(${engagementIds}::uuid[]) order by kind, created_at`,
    () => sql`select id, engagement_id, role, status, scheduled_for, reason, run_id, provider, snapshot, comparability, comparison, frozen_at, status_detail
        from engagement_measurements where engagement_id = any(${engagementIds}::uuid[])
        order by (role = 'baseline') desc, coalesce(scheduled_for, frozen_at::date, created_at::date) asc, created_at asc`,
    () => sql`select id, contract_ref, kind, amount_cents, due_date, occurred_at, external_invoice_id
        from billing_events where contract_ref = any(${contractRefs}::text[]) order by occurred_at asc`,
    () => sql`select distinct on (entity_id) entity_id, at, detail from audit_log
        where entity = 'client_engagement' and action = 'engagement.client_update_sent' and entity_id = any(${engagementIds}::uuid[])
        order by entity_id, at desc`,
    () => sql`select a.project_id, count(*)::int as n from user_project_access a join users u on u.id = a.user_id
        where a.project_id = any(${projectIds}::uuid[]) and u.role = 'client_viewer' group by a.project_id`,
    () => sql`select engagement_id, lane, code, severity, message, detail from engagement_qa_events
        where engagement_id = any(${engagementIds}::uuid[]) and status = 'open'`,
    () => sql`select id, project_id, title, shipped_at, urls, hypothesis, client_visible from interventions
        where project_id = any(${projectIds}::uuid[]) and archived_at is null`,
    () => sql`select id, project_id, title, updated_at from content_assets where project_id = any(${projectIds}::uuid[]) and status = 'published'`,
    () => (prospectIds.length > 0 ? sql`select id, do_not_contact from prospects where id = any(${prospectIds}::uuid[])` : Promise.resolve([] as Record<string, unknown>[])),
    () => sql<MarketNode[]>`select id, name, parent_id from markets` as unknown as Promise<Record<string, unknown>[]>,
    () => sql`select 1 from pg_trigger where tgname = 'engagement_measurements_immutable'`,
  ])) as [Record<string, unknown>[], Record<string, unknown>[], Record<string, unknown>[], Record<string, unknown>[], Record<string, unknown>[], Record<string, unknown>[], Record<string, unknown>[], Record<string, unknown>[], Record<string, unknown>[], Record<string, unknown>[], Record<string, unknown>[], Record<string, unknown>[], Record<string, unknown>[], MarketNode[], Record<string, unknown>[]];
  return {
    engagements,
    projectNames: new Map(projects.map((p) => [p.id as string, p.name as string])),
    subjects: new Map(subjects.map((s) => [s.projectId as string, { id: s.id as string, name: s.name as string, aliases: (s.aliases as string[]) ?? [] }])),
    competitors: group(competitors.map((c) => ({ projectId: c.projectId as string, companyId: c.companyId as string, name: c.name as string, archived: Boolean(c.archived) })), (c) => c.projectId),
    tasks: group(tasks.map((r) => ({
      projectId: r.projectId as string,
      id: r.id as string,
      title: r.title as string,
      status: r.status as string,
      priority: r.priority as string,
      clientVisible: Boolean(r.clientVisible),
      observation: (r.observation as string | null) ?? null,
      hypothesis: (r.hypothesis as string | null) ?? null,
      confidence: (r.confidence as string | null) ?? null,
      control: (r.control as string | null) ?? null,
      scope: r.scope as string,
      clientApproval: r.clientApproval as string,
      blockedReason: (r.blockedReason as string | null) ?? null,
      blockedNote: (r.blockedNote as string | null) ?? null,
      targetUrl: (r.targetUrl as string | null) ?? null,
      beforeState: (r.beforeState as string | null) ?? null,
      afterState: (r.afterState as string | null) ?? null,
      implementedAt: (r.implementedAt as Date | null) ?? null,
      dueDate: r.dueDate ? toIso(r.dueDate) : null,
      updatedAt: r.updatedAt as Date,
      evidenceCount: Number(r.evidenceCount ?? 0),
    })), (t) => t.projectId),
    context: group(context.map((r) => ({
      engagementId: r.engagementId as string,
      id: r.id as string,
      kind: r.kind as string,
      label: r.label as string,
      value: (r.value as Record<string, unknown>) ?? {},
      provenance: r.provenance as string,
      accessStatus: (r.accessStatus as string | null) ?? null,
      sourceRef: (r.sourceRef as string | null) ?? null,
      createdAt: r.createdAt as Date,
    })), (c) => c.engagementId),
    measurements: group(measurements.map((r) => ({
      engagementId: r.engagementId as string,
      id: r.id as string,
      role: r.role as string,
      status: r.status as string,
      scheduledFor: r.scheduledFor ? toIso(r.scheduledFor) : null,
      reason: (r.reason as string) ?? "",
      runId: (r.runId as string | null) ?? null,
      provider: (r.provider as string | null) ?? null,
      snapshot: (r.snapshot as MeasurementSnapshot | null) ?? null,
      comparability: (r.comparability as MeasurementComparability | null) ?? null,
      comparison: (r.comparison as MeasurementComparison | null) ?? null,
      frozenAt: (r.frozenAt as Date | null) ?? null,
      statusDetail: (r.statusDetail as string | null) ?? null,
    })), (m) => m.engagementId),
    billing: group(billing.map((r) => ({
      engagementId: String(r.contractRef).replace(/^engagement:/, ""),
      id: r.id as string,
      kind: r.kind as string,
      amountCents: Number(r.amountCents ?? 0),
      dueDate: r.dueDate ? toIso(r.dueDate) : null,
      occurredAt: r.occurredAt as Date,
      externalInvoiceId: (r.externalInvoiceId as string | null) ?? null,
    })), (b) => b.engagementId),
    lastUpdate: new Map(updates.map((u) => [u.entityId as string, { at: u.at as Date, channel: String((u.detail as Record<string, unknown>).channel ?? ""), summary: String((u.detail as Record<string, unknown>).summary ?? "") }])),
    grants: new Map(grants.map((g) => [g.projectId as string, Number(g.n)])),
    qaEvents: group(qaEvents.map((q) => ({ engagementId: q.engagementId as string, lane: q.lane as QaLane, code: q.code as string, severity: q.severity as QaSeverity, message: q.message as string, detail: (q.detail as Record<string, unknown>) ?? {} })), (q) => q.engagementId),
    interventions: group(interventions.map((i) => ({
      projectId: i.projectId as string,
      kind: "intervention" as const,
      id: i.id as string,
      at: new Date(i.shippedAt as Date),
      title: i.title as string,
      targetUrl: ((i.urls as string[]) ?? [])[0] ?? null,
      before: null,
      after: null,
      reason: (i.hypothesis as string | null) ?? null,
      clientVisible: Boolean(i.clientVisible),
      approval: null,
    })), (i) => i.projectId),
    content: group(content.map((c) => ({
      projectId: c.projectId as string,
      kind: "content" as const,
      id: c.id as string,
      at: c.updatedAt as Date,
      title: c.title as string,
      targetUrl: null,
      before: null,
      after: "Published",
      reason: null,
      clientVisible: true,
      approval: null,
    })), (c) => c.projectId),
    prospects: new Map(prospects.map((p) => [p.id as string, { doNotContact: Boolean(p.doNotContact) }])),
    markets,
    triggerPresent: trigger.length > 0,
  };
}

/** Other live engagements whose market is the same as, inside, or containing this one. */
function marketConflicts(e: EngagementRow, all: EngagementRow[], markets: MarketNode[]): { engagementId: string; projectId: string; marketName: string; relation: string }[] {
  const out: { engagementId: string; projectId: string; marketName: string; relation: string }[] = [];
  for (const other of all) {
    if (other.projectId === e.projectId) continue;
    if (!(LIVE as readonly string[]).includes(other.stage)) continue;
    const rel = geoRelation(e.marketId, other.marketId, markets);
    if (rel === "unrelated" || rel === "sibling") continue;
    out.push({ engagementId: other.id, projectId: other.projectId, marketName: other.marketName, relation: rel });
  }
  return out;
}

// -------------------------------------------------------------- assembly

export interface PortfolioClient {
  overview: EngagementOverview;
  clientName: string;
  engagementDay: number;
  billingState: BillingState;
  alerts: PortfolioAlert[];
  qaStatus: QaStatus;
  waitingOn: WaitingOn;
  loop: LoopPosition;
  activation: { verdict: QaVerdict; issues: QaIssue[] };
  offboarding: QaIssue[];
  openQaIssues: QaIssue[];
  questions: OnboardingQuestion[];
  weeklyUpdateQa: { verdict: "PASS" | "ISSUES"; issues: QaIssue[] };
  factPack: CommunicationFactPack;
  /** The one line the orchestrator shows. */
  headline: string;
}

function assemble(e: EngagementRow, data: PortfolioData, now: Date, otherClientNames: string[]): PortfolioClient {
  const today = todayIso(now);
  const subject = data.subjects.get(e.projectId) ?? null;
  const work = data.tasks.get(e.projectId) ?? [];
  const context = data.context.get(e.id) ?? [];
  const measurements = data.measurements.get(e.id) ?? [];
  const events = data.billing.get(e.id) ?? [];
  const competitors = data.competitors.get(e.projectId) ?? [];
  const conflicts = marketConflicts(e, data.engagements, data.markets);
  const grants = data.grants.get(e.projectId) ?? 0;
  const openQaIssues = data.qaEvents.get(e.id) ?? [];
  const clientName = data.projectNames.get(e.projectId) ?? "Client";

  const paidInvoices = new Set(events.filter((x) => x.kind === "payment_received" && x.externalInvoiceId).map((x) => x.externalInvoiceId));
  const billing: BillingSummary = {
    invoicedCents: events.filter((x) => x.kind === "invoice_created").reduce((s, x) => s + x.amountCents, 0),
    receivedCents: events.filter((x) => x.kind === "payment_received").reduce((s, x) => s + x.amountCents, 0),
    overdueCount: events.filter((x) => x.kind === "invoice_created" && x.dueDate && x.dueDate < today && !(x.externalInvoiceId && paidInvoices.has(x.externalInvoiceId))).length,
    events,
  };
  const baseline = measurements.find((m) => m.role === "baseline" && m.status === "frozen") ?? null;
  const checklist: ChecklistItem[] = onboardingChecklist({
    contractStatus: e.contractStatus,
    paymentsReceivedCents: billing.receivedCents,
    activationOverrideReason: e.activationOverrideReason,
    subjectLinked: Boolean(subject),
    primaryContactNamed: e.primaryContactName.trim().length > 0,
    marketDefinitionConfirmed: Boolean(e.marketDefinitionConfirmedAt),
    exclusivityStatus: e.exclusivityStatus,
    exclusivityConflictFree: conflicts.length === 0,
    priorityItems: context.filter((i) => i.provenance === "client_priority").length,
    assetItems: context.filter((i) => i.kind === "asset").length,
    accessRequestedOpen: context.filter((i) => i.kind === "access" && i.accessStatus === "requested").length,
    baselineFrozen: Boolean(baseline),
    planItems: work.filter((t) => t.status !== "rejected").length,
  });
  const commercial = commercialGate({ contractStatus: e.contractStatus, paymentsReceivedCents: billing.receivedCents, activationOverrideReason: e.activationOverrideReason });
  const derivedStage = deriveStage(e.stage, e.renewalReviewOn, today);
  const renewalStatus = deriveRenewalStatus({ endsOn: e.endsOn, renewalReviewOn: e.renewalReviewOn, stored: e.renewalStatus, stage: e.stage }, today);
  const planned = measurements.filter((m) => m.status === "planned" && m.scheduledFor).sort((a, b) => a.scheduledFor!.localeCompare(b.scheduledFor!));
  const nextMeasurement = planned[0] ?? null;
  const changes: ChangeLogEntry[] = [
    ...work.filter((t) => t.status === "done").map((t) => ({
      kind: "task" as const,
      id: t.id,
      at: t.implementedAt ?? t.updatedAt,
      title: t.title,
      targetUrl: t.targetUrl,
      before: t.beforeState,
      after: t.afterState,
      reason: t.hypothesis,
      clientVisible: t.clientVisible,
      approval: t.clientApproval,
    })),
    ...(data.interventions.get(e.projectId) ?? []),
    ...(data.content.get(e.projectId) ?? []),
  ].sort((a, b) => b.at.getTime() - a.at.getTime());
  const openApprovals = work.filter((t) => t.clientApproval === "required" && t.status !== "rejected").length;
  const blockedOnClient = work.filter((t) => t.blockedReason === "client_access" || t.blockedReason === "client_approval" || t.blockedReason === "client_input").length;
  const blockedOnUs = work.filter((t) => t.blockedReason === "third_party" || t.blockedReason === "internal").length;
  const lastUpdate = data.lastUpdate.get(e.id) ?? null;
  const onboardingDone = onboardingComplete(checklist);
  const signals = healthSignals({
    stage: derivedStage,
    onboardingDone,
    openApprovals,
    blockedOnClient,
    blockedOnUs,
    tasksInProgress: work.filter((t) => t.status === "in_progress").length,
    tasksDone: work.filter((t) => t.status === "done").length,
    nextMeasurementOn: nextMeasurement?.scheduledFor ?? null,
    overdueInvoices: billing.overdueCount,
    lastClientUpdateOn: lastUpdate ? lastUpdate.at.toISOString().slice(0, 10) : null,
    renewalStatus,
    today,
  });
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
  const latestFrozen = measurements.filter((m) => m.role !== "baseline" && m.status !== "planned" && m.frozenAt && m.frozenAt >= weekAgo)[0];
  const weeklyUpdate = composeWeeklyUpdate({
    clientName,
    weekEnding: today,
    done: changes.filter((c) => c.clientVisible && c.at >= weekAgo).map((c) => `${c.title}${c.targetUrl ? ` (${c.targetUrl})` : ""}${c.after ? ` — now: ${c.after}` : ""}`),
    inProgress: work.filter((t) => t.status === "in_progress" && t.clientVisible).map((t) => t.title),
    needFromYou: [
      ...work.filter((t) => t.clientApproval === "required" && t.clientVisible).map((t) => `Approve: ${t.title}`),
      ...work.filter((t) => (t.blockedReason === "client_access" || t.blockedReason === "client_input") && t.clientVisible).map((t) => `${t.blockedReason === "client_access" ? "Access" : "Input"} needed: ${t.title}${t.blockedNote ? ` — ${t.blockedNote}` : ""}`),
    ],
    measurement: latestFrozen
      ? latestFrozen.comparison
        ? `- ${latestFrozen.comparison.statement} Comparability: ${latestFrozen.comparability?.grade}.`
        : `- A remeasurement ran but is NON-COMPARABLE to the baseline (${latestFrozen.statusDetail ?? "instrument changed"}); no before/after is claimed.`
      : null,
    next: [
      ...work.filter((t) => t.status === "approved" && t.clientVisible).slice(0, 3).map((t) => `Start: ${t.title}`),
      ...(nextMeasurement ? [`Remeasurement (${nextMeasurement.role}) scheduled for ${nextMeasurement.scheduledFor}.`] : []),
    ],
  });
  const measurementDue = Boolean(nextMeasurement && nextMeasurement.scheduledFor! <= today);
  const overview: EngagementOverview = {
    engagement: e,
    derivedStage,
    renewalStatus,
    commercial,
    checklist,
    onboardingDone,
    signals,
    nextAction: nextAction({ stage: derivedStage, commercial, checklist, openApprovals, blockedOnClient, measurementDue, renewalStatus }),
    work,
    context,
    measurements,
    nextMeasurement,
    billing,
    changes,
    lastClientUpdate: lastUpdate,
    weeklyUpdate,
    marketConflicts: conflicts,
    portalGrants: grants,
  };

  // ---- QA lanes -----------------------------------------------------------
  const activation = activationQa({
    stage: derivedStage,
    subjectLinked: Boolean(subject),
    primaryContactNamed: e.primaryContactName.trim().length > 0,
    startsOn: e.startsOn,
    endsOn: e.endsOn,
    monthlyFeeUsd: e.monthlyFeeUsd,
    totalValueUsd: e.totalValueUsd,
    contractStatus: e.contractStatus,
    contractRef: e.contractRef,
    paymentsReceivedCents: billing.receivedCents,
    activationOverrideReason: e.activationOverrideReason,
    marketDefinitionConfirmed: Boolean(e.marketDefinitionConfirmedAt),
    exclusivityStatus: e.exclusivityStatus,
    marketConflicts: conflicts.length,
    competitorCount: competitors.length,
    competitorConfirmed: context.some((i) => (i.kind === "competitor" || i.kind === "excluded_competitor") && i.provenance === "client_confirmed"),
    baseline: baseline?.snapshot ?? null,
    baselineImmutableTrigger: data.triggerPresent,
    priorityItems: context.filter((i) => i.provenance === "client_priority").length,
    accessUnknown: context.filter((i) => i.kind === "access" && i.accessStatus === "requested").length,
    today,
  });
  const offboarding = offboardingQa({
    stage: e.stage,
    agreementStatus: e.exclusivityStatus,
    portalGrants: grants,
    plannedMeasurements: planned.length,
    openTasks: work.filter((t) => t.status === "suggested" || t.status === "approved" || t.status === "in_progress").length,
    accessGranted: context.filter((i) => i.kind === "access" && i.accessStatus === "granted").length,
    cooldownUntil: e.cooldownUntil,
    prospectDoNotContact: e.prospectId ? (data.prospects.get(e.prospectId)?.doNotContact ?? null) : null,
  });
  const lastChange = changes[0]?.at ?? null;
  const state: BillingState = billingState(events.map((x) => ({ kind: x.kind, amountCents: x.amountCents, dueDate: x.dueDate, externalInvoiceId: x.externalInvoiceId })), today);
  const liveQaIssues = [...openQaIssues, ...activation.issues.filter((i) => i.severity !== "P2" && derivedStage !== "signed"), ...offboarding];
  const alerts = portfolioAlerts({
    stage: derivedStage,
    startsOn: e.startsOn,
    endsOn: e.endsOn,
    renewalReviewOn: e.renewalReviewOn,
    renewalStatus,
    onboardingDone,
    checklist,
    commercialReady: commercial.ready,
    commercialReasons: commercial.reasons,
    exclusivityStatus: e.exclusivityStatus,
    agreementEndsOn: null,
    marketConflicts: conflicts.length,
    tasks: work.map((t) => ({ status: t.status, clientApproval: t.clientApproval, blockedReason: t.blockedReason, updatedAt: t.updatedAt.toISOString(), implementedAt: t.implementedAt ? t.implementedAt.toISOString() : null, scope: t.scope })),
    lastChangeAt: lastChange ? lastChange.toISOString().slice(0, 10) : null,
    lastMeasurementAt: latestFrozen?.frozenAt ? latestFrozen.frozenAt.toISOString().slice(0, 10) : null,
    nextMeasurementOn: nextMeasurement?.scheduledFor ?? null,
    lastClientUpdateOn: lastUpdate ? lastUpdate.at.toISOString().slice(0, 10) : null,
    billing: state,
    portalGrants: grants,
    openQaIssues: liveQaIssues,
    today,
  });
  for (const o of offboarding) {
    alerts.push({ code: "OFFBOARDING_INCOMPLETE", severity: o.severity, message: o.message, nextAction: "Finish the offboarding step.", waitingOn: "us", rank: o.severity === "P0" ? 0 : 1, blocking: o.severity === "P0" });
  }
  alerts.sort((a, b) => a.rank - b.rank);
  const latestComparable = measurements.filter((m) => m.role !== "baseline" && m.comparison).sort((a, b) => (b.frozenAt?.getTime() ?? 0) - (a.frozenAt?.getTime() ?? 0))[0];
  const loop = loopPosition({
    stage: derivedStage,
    baseline: Boolean(baseline),
    hypotheses: work.filter((t) => t.hypothesis && t.status !== "rejected").length,
    activeWork: work.filter((t) => t.status === "in_progress" || t.status === "approved").length,
    implemented: work.filter((t) => t.status === "done").length,
    nextMeasurementOn: nextMeasurement?.scheduledFor ?? null,
    latestResult: latestComparable?.comparison?.statement ?? null,
    renewalStatus,
  });
  if (loop.missing.length > 0 && derivedStage === "active") {
    alerts.push({ code: "LOOP_LINK_MISSING", severity: "P1", message: `Operating loop missing: ${loop.missing.join(", ")}.`, nextAction: "Restore the missing link (baseline, hypotheses, work or next measurement).", waitingOn: "us", rank: 1 });
  }
  const rivalLeadsOn = baseline?.snapshot
    ? baseline.snapshot.questions.filter((q) => q.subjectRecommended === 0 && Object.values(q.competitorRecommended).some((n) => n > 0)).map((q) => q.text)
    : [];
  const questions = onboardingQuestions({
    context,
    baseline: baseline?.snapshot ?? null,
    competitorNames: (baseline?.snapshot?.competitors ?? competitors).map((c) => c.name),
    ownSiteKnown: context.some((i) => i.kind === "asset"),
    brokerageKnown: true,
    primaryContactNamed: e.primaryContactName.trim().length > 0,
    rivalLeadsOn,
  });
  const canonicalCounts = new Set<string>();
  for (const m of measurements) {
    if (!m.snapshot) continue;
    canonicalCounts.add(`${m.snapshot.subject.recommendedCount} of ${m.snapshot.answerCount}`);
    canonicalCounts.add(`${m.snapshot.subject.distinctQuestions} of ${m.snapshot.questionCount}`);
    for (const c of m.snapshot.competitors) {
      canonicalCounts.add(`${c.recommendedCount} of ${m.snapshot.answerCount}`);
      canonicalCounts.add(`${c.distinctQuestions} of ${m.snapshot.questionCount}`);
    }
  }
  const factPack: CommunicationFactPack = {
    clientName,
    marketName: e.marketName,
    otherClientNames: otherClientNames.filter((n) => n !== clientName),
    canonicalCounts: [...canonicalCounts],
    doneTitles: work.filter((t) => t.status === "done").map((t) => t.title),
    inProgressTitles: work.filter((t) => t.status === "in_progress").map((t) => t.title),
    blockedTitles: work.filter((t) => t.blockedReason).map((t) => t.title),
    approvalTitles: work.filter((t) => t.clientApproval === "required").map((t) => t.title),
    nextMeasurementOn: nextMeasurement?.scheduledFor ?? null,
    engagementEndsOn: e.endsOn,
  };
  const top = alerts[0];
  const headline = top ? `${top.code.replace(/_/g, " ")} — ${top.message} Next: ${top.nextAction}` : `On track. Next: ${overview.nextAction}`;
  return {
    overview,
    clientName,
    engagementDay: Math.max(0, Math.round((now.getTime() - Date.parse(`${e.startsOn}T00:00:00Z`)) / 86_400_000)),
    billingState: state,
    alerts,
    qaStatus: qaStatusFor(alerts),
    waitingOn: waitingOnSummary(alerts),
    loop,
    activation,
    offboarding,
    openQaIssues,
    questions,
    weeklyUpdateQa: communicationQa(weeklyUpdate, factPack),
    factPack,
    headline,
  };
}

// ------------------------------------------------------------------ reads

export interface PortfolioScan {
  scannedAt: Date;
  clients: PortfolioClient[];
  capacity: {
    liveEngagements: number;
    activeWorkItems: number;
    approvalsWaiting: number;
    blockedOnClient: number;
    measurementsDue: number;
    clientWaitingOnUs: number;
    p0: number;
  };
  /** Orchestrator: clients ordered by their top alert; safety → waiting on us → measurement → communication → routine. */
  priorities: { client: PortfolioClient; alert: PortfolioAlert | null }[];
}

export async function portfolioScan(now = new Date(), opts: { includeRecentlyClosed?: boolean; cache?: boolean } = {}): Promise<PortfolioScan> {
  const key = `${opts.includeRecentlyClosed ?? true}`;
  if (opts.cache) {
    const hit = scanCache.get(key);
    if (hit && now.getTime() - hit.at < SCAN_CACHE_MS) return hit.scan;
  }
  const scan = await portfolioScanUncached(now, opts);
  if (opts.cache) scanCache.set(key, { at: now.getTime(), scan });
  return scan;
}

async function portfolioScanUncached(now: Date, opts: { includeRecentlyClosed?: boolean }): Promise<PortfolioScan> {
  const engagements = await loadEngagements({ includeRecentlyClosed: opts.includeRecentlyClosed ?? true }, now);
  if (engagements.length === 0) {
    return { scannedAt: now, clients: [], capacity: { liveEngagements: 0, activeWorkItems: 0, approvalsWaiting: 0, blockedOnClient: 0, measurementsDue: 0, clientWaitingOnUs: 0, p0: 0 }, priorities: [] };
  }
  const data = await loadPortfolioData(engagements);
  const names = engagements.map((e) => data.projectNames.get(e.projectId) ?? "");
  const clients = engagements.map((e) => assemble(e, data, now, names));
  const live = clients.filter((c) => (LIVE as readonly string[]).includes(c.overview.engagement.stage));
  const today = todayIso(now);
  const capacity = {
    liveEngagements: live.length,
    activeWorkItems: live.reduce((s, c) => s + c.overview.work.filter((t) => t.status === "in_progress" || t.status === "approved").length, 0),
    approvalsWaiting: live.reduce((s, c) => s + c.overview.work.filter((t) => t.clientApproval === "required" && t.status !== "rejected").length, 0),
    blockedOnClient: live.reduce((s, c) => s + c.overview.work.filter((t) => t.blockedReason === "client_input" || t.blockedReason === "client_access").length, 0),
    measurementsDue: live.filter((c) => c.overview.nextMeasurement?.scheduledFor && c.overview.nextMeasurement.scheduledFor <= today).length,
    clientWaitingOnUs: clients.filter((c) => c.waitingOn === "us").length,
    p0: clients.filter((c) => c.qaStatus === "P0").length,
  };
  const priorities = clients
    .filter((c) => c.alerts.length > 0 || (LIVE as readonly string[]).includes(c.overview.engagement.stage))
    .map((c) => ({ client: c, alert: c.alerts[0] ?? null }))
    .sort((a, b) => (a.alert?.rank ?? 9) - (b.alert?.rank ?? 9) || sevRank(a.alert?.severity) - sevRank(b.alert?.severity) || a.client.clientName.localeCompare(b.client.clientName));
  return { scannedAt: now, clients, capacity, priorities };
}

function sevRank(s: QaSeverity | undefined): number {
  return s === "P0" ? 0 : s === "P1" ? 1 : s === "P2" ? 2 : 3;
}

/** One client, assembled the same way (the engagement page and portal read). */
export async function portfolioClient(projectId: string, now = new Date()): Promise<PortfolioClient | null> {
  const engagements = await loadEngagements({ projectId, includeRecentlyClosed: true }, now);
  if (engagements.length === 0) return null;
  // Conflicts need every other live engagement's market; load them too.
  const others = (await loadEngagements({ includeRecentlyClosed: false }, now)).filter((e) => e.id !== engagements[0]!.id);
  const all = [...engagements, ...others];
  const data = await loadPortfolioData(all);
  const names = all.map((e) => data.projectNames.get(e.projectId) ?? "");
  return assemble(engagements[0]!, data, now, names);
}

// ---------------------------------------------------- persistence + lanes

const MATERIAL: ReadonlySet<QaSeverity> = new Set(["P0", "P1"]);

/** Upsert open events for material alerts; resolve open events the scan no
 * longer produces. Portfolio lane codes are the alert codes. */
export async function persistPortfolioScan(scan: PortfolioScan, durationMs: number): Promise<{ opened: number; resolved: number }> {
  let opened = 0;
  let resolved = 0;
  await sql.begin(async (tx) => {
    for (const c of scan.clients) {
      const e = c.overview.engagement;
      const wanted = new Map<string, PortfolioAlert>();
      for (const a of c.alerts) {
        if (!MATERIAL.has(a.severity)) continue;
        if (a.code === "QA_FAILURE" || a.code === "QA_ATTENTION" || a.code === "EVIDENCE_QA_FAILURE" || a.code === "BASELINE_QA_FAILURE") continue; // echoes of stored events
        wanted.set(a.code, a);
      }
      const open = await tx`select id, code from engagement_qa_events where engagement_id = ${e.id} and lane = 'portfolio' and status = 'open'`;
      for (const row of open) {
        if (!wanted.has(row.code as string)) {
          await tx`update engagement_qa_events set status = 'resolved', resolved_at = now() where id = ${row.id}`;
          resolved += 1;
        }
      }
      for (const [code, a] of wanted) {
        const existing = open.find((r) => r.code === code);
        if (existing) {
          await tx`update engagement_qa_events set last_seen_at = now(), message = ${a.message}, severity = ${a.severity} where id = ${existing.id}`;
        } else {
          await tx`
            insert into engagement_qa_events (engagement_id, project_id, lane, code, severity, message, detail)
            values (${e.id}, ${e.projectId}, 'portfolio', ${code}, ${a.severity}, ${a.message}, ${tx.json({ nextAction: a.nextAction, waitingOn: a.waitingOn })})
          `;
          opened += 1;
        }
      }
    }
    await tx`
      insert into portfolio_qa_scans (engagements, alerts, p0, p1, duration_ms, detail)
      values (${scan.clients.length}, ${scan.clients.reduce((s, c) => s + c.alerts.length, 0)},
        ${scan.capacity.p0}, ${scan.clients.reduce((s, c) => s + c.alerts.filter((a) => a.severity === "P1").length, 0)},
        ${Math.round(durationMs)}, ${tx.json({ capacity: scan.capacity } as never)})
    `;
  });
  return { opened, resolved };
}

/** Daily evidence drift: recompute each frozen baseline from its run and
 * compare. The package is never mutated; drift becomes an open evidence
 * event for a human. */
export async function evidenceDriftScan(): Promise<{ checked: number; flagged: number }> {
  const rows = await sql`
    select m.id, m.engagement_id, m.project_id, m.snapshot, m.provider, m.run_id, m.subject_company_id, m.competitor_company_ids
    from engagement_measurements m join client_engagements e on e.id = m.engagement_id
    where m.role = 'baseline' and m.status = 'frozen' and e.stage in ('signed','onboarding','active','renewal_review')
  `;
  let flagged = 0;
  for (const row of rows) {
    const frozen = row.snapshot as MeasurementSnapshot;
    const competitorIds = (row.competitorCompanyIds as string[]) ?? [];
    let issues: QaIssue[] = [];
    try {
      const current = await buildMeasurementSnapshot({ runId: row.runId as string, provider: row.provider as string, subjectCompanyId: row.subjectCompanyId as string, competitorCompanyIds: competitorIds });
      const [subject] = await sql`select aliases from companies where id = ${row.subjectCompanyId}`;
      const archived = competitorIds.length > 0 ? await sql`select id from companies where id = any(${competitorIds}::uuid[]) and (archived_at is not null or merged_into is not null)` : [];
      issues = evidenceDriftQa({ frozen, current, subjectAliasesNow: (subject?.aliases as string[]) ?? [], competitorsArchived: archived.map((a) => a.id as string) });
      if (frozen.versions.resolverPolicy !== RESOLVER_POLICY_VERSION && !issues.some((i) => i.code === "ENTITY_DRIFT")) {
        issues.push({ lane: "evidence", code: "ENTITY_DRIFT", severity: "P1", message: `Resolver policy is now ${RESOLVER_POLICY_VERSION}; baseline used ${frozen.versions.resolverPolicy}.` });
      }
    } catch (err) {
      issues = [{ lane: "evidence", code: "RECOMPUTE_FAILED", severity: "P1", message: `Could not recompute the baseline run: ${err instanceof Error ? err.message : "unknown"}` }];
    }
    await sql.begin(async (tx) => {
      const open = await tx`select id, code from engagement_qa_events where engagement_id = ${row.engagementId} and lane = 'evidence' and status = 'open'`;
      const codes = new Set(issues.map((i) => i.code));
      for (const o of open) {
        if (!codes.has(o.code as string)) await tx`update engagement_qa_events set status = 'resolved', resolved_at = now() where id = ${o.id}`;
      }
      for (const i of issues) {
        const existing = open.find((o) => o.code === i.code);
        if (existing) await tx`update engagement_qa_events set last_seen_at = now(), message = ${i.message}, detail = ${tx.json((i.detail ?? {}) as never)} where id = ${existing.id}`;
        else await tx`insert into engagement_qa_events (engagement_id, project_id, lane, code, severity, message, detail) values (${row.engagementId}, ${row.projectId}, 'evidence', ${i.code}, ${i.severity}, ${i.message}, ${tx.json((i.detail ?? {}) as never)})`;
      }
    });
    if (issues.length > 0) flagged += 1;
  }
  return { checked: rows.length, flagged };
}

/** Windowed daily run for the automation tick: portfolio scan + evidence drift. */
export async function runDailyDeliveryQa(now = new Date()): Promise<Record<string, unknown>> {
  const [last] = await sql`select ran_at from portfolio_qa_scans order by ran_at desc limit 1`;
  if (last && now.getTime() - new Date(last.ranAt as Date).getTime() < PORTFOLIO_SCAN_WINDOW_HOURS * 3_600_000) {
    return { alreadyRan: true, lastRanAt: last.ranAt };
  }
  const started = Date.now();
  const scan = await portfolioScan(now);
  const persisted = await persistPortfolioScan(scan, Date.now() - started);
  const drift = await evidenceDriftScan();
  return { alreadyRan: false, engagements: scan.clients.length, alerts: scan.clients.reduce((s, c) => s + c.alerts.length, 0), ...persisted, drift, durationMs: Date.now() - started };
}

export interface QaEventRow {
  id: string;
  lane: string;
  code: string;
  severity: QaSeverity;
  status: string;
  message: string;
  detail: Record<string, unknown>;
  firstSeenAt: Date;
  lastSeenAt: Date;
  overrideReason: string | null;
}

export async function listQaEvents(engagementId: string, opts: { includeClosed?: boolean } = {}): Promise<QaEventRow[]> {
  const rows = await sql`
    select id, lane, code, severity, status, message, detail, first_seen_at, last_seen_at, override_reason
    from engagement_qa_events where engagement_id = ${engagementId}
      ${opts.includeClosed ? sql`` : sql`and status = 'open'`}
    order by (severity = 'P0') desc, (severity = 'P1') desc, first_seen_at desc
  `;
  return rows.map((r) => ({
    id: r.id as string,
    lane: r.lane as string,
    code: r.code as string,
    severity: r.severity as QaSeverity,
    status: r.status as string,
    message: r.message as string,
    detail: (r.detail as Record<string, unknown>) ?? {},
    firstSeenAt: r.firstSeenAt as Date,
    lastSeenAt: r.lastSeenAt as Date,
    overrideReason: (r.overrideReason as string | null) ?? null,
  }));
}

/** Founder override of a QA event: actor, time, reason, previous result kept. */
export async function overrideQaEvent(user: CurrentUser, raw: unknown): Promise<ActionResult<{ eventId: string }>> {
  const parsed = z.object({ eventId: z.string().uuid(), reason: z.string().trim().min(10).max(2000) }).safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  try {
    assertRole(user, "admin");
    await sql.begin(async (tx) => {
      const [row] = await tx`select * from engagement_qa_events where id = ${parsed.data.eventId} for update`;
      if (!row) throw new ClassifiedError("not_found", "QA event not found.");
      if (row.status !== "open") throw new ClassifiedError("conflict", `QA event is ${row.status}.`);
      const previous = { severity: row.severity, message: row.message, detail: row.detail, lastSeenAt: row.lastSeenAt };
      await tx`
        update engagement_qa_events set status = 'overridden', override_by = ${user.id}, override_at = now(),
          override_reason = ${parsed.data.reason}, previous_result = ${tx.json(previous as never)}
        where id = ${row.id}
      `;
      await writeAudit(tx, { userId: user.id, action: "engagement.qa_override", entity: "client_engagement", entityId: row.engagementId as string, projectId: row.projectId as string, detail: { eventId: row.id as string, lane: row.lane as string, code: row.code as string, reason: parsed.data.reason } });
    });
    return ok({ eventId: parsed.data.eventId });
  } catch (err) {
    return fail(err);
  }
}
