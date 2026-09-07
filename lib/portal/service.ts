/**
 * Client portal reads (spec 031). Strictly read-only, strictly a subset:
 * nothing here computes a number the internal app doesn't already show,
 * and nothing internal-only (costs, notes, non-client_visible tasks,
 * draft reports) can pass through these functions — the filter is in the
 * SQL, not in the rendering.
 */
import { sql } from "@/db/client";
import { getSubjectCompany } from "@/db/companies";
import { authorityTrend, type TrendPoint } from "@/db/dashboard";
import { assertProjectAccess, type CurrentUser } from "@/lib/auth";

export interface PortalHeadline {
  metric: string;
  value: number;
  sampleSize: number;
  scoringVersion: string;
}

export interface PortalOverview {
  subjectName: string | null;
  headlines: PortalHeadline[];
  trend: TrendPoint[];
  lastMeasuredAt: Date | null;
  /** The FIRST scored run's recommendation rate — the "since we started"
   * anchor the hero delta is measured against (spec 085). Null with fewer
   * than one scored run. */
  baseline: { value: number; sampleSize: number; at: Date } | null;
  /** Weekly measurement configured? Drives the cadence line honestly. */
  measurementScheduled: boolean;
  latestReport: { id: string; title: string; publishedAt: Date } | null;
}

const HEADLINE_METRICS = [
  "mention_rate",
  "recommendation_rate",
  "first_position_rate",
];

export async function portalOverview(
  user: CurrentUser,
  projectId: string
): Promise<PortalOverview> {
  // The layout gates too, but Next.js layouts are not an authorization
  // boundary (plan 4.2) — every portal read re-asserts for itself.
  await assertProjectAccess(user, projectId);
  const subject = await getSubjectCompany(projectId);
  const [config] = await sql`
    select baseline_prompt_set_id from projects where id = ${projectId}
  `;
  const measurementScheduled = Boolean(config?.baselinePromptSetId);
  if (!subject) {
    return {
      subjectName: null,
      headlines: [],
      trend: [],
      lastMeasuredAt: null,
      baseline: null,
      measurementScheduled,
      latestReport: null,
    };
  }
  const [latest] = await sql`
    select r.id, r.started_at from runs r
    where r.project_id = ${projectId}
      and exists (select 1 from scores s
        where s.run_id = r.id and s.company_id = ${subject.id})
    order by r.started_at desc limit 1
  `;
  const headlines = latest
    ? await sql<PortalHeadline[]>`
        select metric, value, sample_size, scoring_version
        from scores
        where run_id = ${latest.id} and company_id = ${subject.id}
          and provider = 'all' and metric = any(${HEADLINE_METRICS})
        order by array_position(${HEADLINE_METRICS}::text[], metric)
      `
    : [];
  const [first] = await sql`
    select r.started_at, s.value, s.sample_size
    from runs r
    join scores s on s.run_id = r.id and s.company_id = ${subject.id}
      and s.provider = 'all' and s.metric = 'recommendation_rate'
    where r.project_id = ${projectId}
    order by r.started_at asc limit 1
  `;
  const [report] = await sql`
    select id, title, published_at from reports
    where project_id = ${projectId} and status = 'published'
    order by published_at desc limit 1
  `;
  return {
    subjectName: subject.name,
    headlines: headlines.map((h) => ({
      metric: h.metric,
      value: Number(h.value),
      sampleSize: Number(h.sampleSize),
      scoringVersion: h.scoringVersion,
    })),
    trend: await authorityTrend(projectId),
    lastMeasuredAt: latest ? (latest.startedAt as Date) : null,
    baseline:
      first && latest && first.startedAt < latest.startedAt
        ? {
            value: Number(first.value),
            sampleSize: Number(first.sampleSize),
            at: first.startedAt as Date,
          }
        : null,
    measurementScheduled,
    latestReport: report
      ? {
          id: report.id as string,
          title: report.title as string,
          publishedAt: report.publishedAt as Date,
        }
      : null,
  };
}

export interface PortalRival {
  name: string;
  value: number;
  sampleSize: number;
  isClient: boolean;
}

/** "You vs the rivals you lose listings to" (spec 085): the latest run's
 * recommendation rates for the client and their TRACKED competitors —
 * names a client already knows, never other clients' data (competitors
 * are project-scoped by table design). */
export async function portalCompetitive(
  user: CurrentUser,
  projectId: string
): Promise<PortalRival[]> {
  await assertProjectAccess(user, projectId);
  const subject = await getSubjectCompany(projectId);
  if (!subject) return [];
  const [latest] = await sql`
    select r.id from runs r
    where r.project_id = ${projectId}
      and exists (select 1 from scores s
        where s.run_id = r.id and s.company_id = ${subject.id})
    order by r.started_at desc limit 1
  `;
  if (!latest) return [];
  const rows = await sql`
    select c.name, s.value, s.sample_size,
      (s.company_id = ${subject.id}) as is_client
    from scores s
    join companies c on c.id = s.company_id
    where s.run_id = ${latest.id} and s.provider = 'all'
      and s.metric = 'recommendation_rate'
      and (s.company_id = ${subject.id} or s.company_id in
        (select company_id from competitors where project_id = ${projectId}))
    order by s.value desc
  `;
  const rivals = rows.map((r) => ({
    name: r.name as string,
    value: Number(r.value),
    sampleSize: Number(r.sampleSize),
    isClient: Boolean(r.isClient),
  }));
  const client = rivals.filter((r) => r.isClient);
  const top = rivals.filter((r) => !r.isClient).slice(0, 5);
  return [...client, ...top].sort((a, z) => z.value - a.value);
}

/** Next Monday (UTC date) — the weekly cadence promise, as arithmetic. */
export function nextMondayIso(now: Date = new Date()): string {
  const date = new Date(now);
  const day = date.getUTCDay();
  const daysAhead = day === 1 ? 7 : (8 - day) % 7 || 7;
  date.setUTCDate(date.getUTCDate() + daysAhead);
  return date.toISOString().slice(0, 10);
}

export interface PortalWorkItem {
  kind: "task" | "content" | "intervention";
  title: string;
  at: Date;
  detail: string | null;
}

/** Proof of work: ONLY client_visible completed tasks and interventions,
 * plus published content. Owner identities and internal notes never leave. */
export async function portalWork(
  user: CurrentUser,
  projectId: string
): Promise<PortalWorkItem[]> {
  await assertProjectAccess(user, projectId);
  const tasks = await sql`
    select title, updated_at as at from tasks
    where project_id = ${projectId} and status = 'done' and client_visible
    order by updated_at desc limit 50
  `;
  const content = await sql`
    -- content_assets has no published_at; updated_at is stamped by
    -- markPublished, the only transition into 'published'.
    select title, updated_at as at from content_assets
    where project_id = ${projectId} and status = 'published'
    order by updated_at desc limit 50
  `;
  // Capped at 20: each verdict line re-derives from stored scores (never
  // stored — spec 007), and the portal must answer "did it work" without
  // unbounded per-request work (spec 051).
  const interventions = await sql`
    select id, title, shipped_at as at from interventions
    where project_id = ${projectId} and archived_at is null and client_visible
    order by shipped_at desc limit 20
  `;
  const { interventionVerdictSummaries } = await import("@/lib/attribution/service");
  const { verdictLine } = await import("@/lib/reports/verdict-language");
  const interventionDetails = new Map<string, string>();
  for (const i of interventions) {
    const summaries = await interventionVerdictSummaries(projectId, i.id as string);
    interventionDetails.set(i.id as string, verdictLine(summaries));
  }
  const items: PortalWorkItem[] = [
    ...tasks.map((t) => ({
      kind: "task" as const,
      title: t.title as string,
      at: t.at as Date,
      detail: null,
    })),
    ...content.map((c) => ({
      kind: "content" as const,
      title: c.title as string,
      at: c.at as Date,
      detail: "Published",
    })),
    ...interventions.map((i) => ({
      kind: "intervention" as const,
      title: i.title as string,
      at: i.at as Date,
      // The computed retest verdict, in client language — the answer to
      // "did it work" was derived and never shown (audit F24).
      detail: interventionDetails.get(i.id as string) ?? "Re-measurement scheduled",
    })),
  ];
  return items
    .filter((i) => i.at !== null)
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}

export interface PortalReport {
  id: string;
  title: string;
  kind: string;
  periodStart: string;
  periodEnd: string;
  publishedAt: Date;
}

export async function portalReports(
  user: CurrentUser,
  projectId: string
): Promise<PortalReport[]> {
  await assertProjectAccess(user, projectId);
  return sql<PortalReport[]>`
    select id, title, kind, period_start::text, period_end::text, published_at
    from reports
    where project_id = ${projectId} and status = 'published'
    order by published_at desc
  `;
}

// ------------------------------------------------------------- spec 131

export interface PortalEngagement {
  startsOn: string;
  endsOn: string;
  stage: string;
  marketName: string;
  scopeSummary: string;
  baseline: {
    provider: string;
    capturedAt: string | null;
    questionCount: number;
    answerCount: number;
    recommendedCount: number;
    distinctQuestions: number;
    competitors: { name: string; recommendedCount: number }[];
  } | null;
  latestMeasurement: {
    at: Date;
    statement: string;
    grade: string;
    reasons: string[];
  } | null;
  nextMeasurementOn: string | null;
  needsYourInput: { id: string; title: string; kind: "approval" | "input" | "access"; detail: string | null; proposedChange: string | null; targetUrl: string | null; why: string | null }[];
  workingOn: { id: string; title: string; why: string | null }[];
  changed: { id: string; title: string; at: Date; targetUrl: string | null; after: string | null; why: string | null }[];
}

/**
 * The client's own engagement view: baseline, what we found, what we are
 * working on, what needs them, what changed, measurement, next. Only
 * client-visible work passes (filtered in SQL); commercial internals
 * (fees, invoices, override reasons, other prospects) never do.
 */
export async function portalEngagement(
  user: CurrentUser,
  projectId: string
): Promise<PortalEngagement | null> {
  await assertProjectAccess(user, projectId);
  const { engagementForProject, listMeasurements } = await import("@/lib/engagements/service");
  const e = await engagementForProject(projectId);
  if (!e) return null;
  const measurements = await listMeasurements(e.id);
  const baseline = measurements.find((m) => m.role === "baseline" && m.status === "frozen")?.snapshot ?? null;
  const latest = measurements
    .filter((m) => m.role !== "baseline" && (m.status === "frozen" || m.status === "non_comparable") && m.frozenAt)
    .sort((a, b) => b.frozenAt!.getTime() - a.frozenAt!.getTime())[0];
  const planned = measurements
    .filter((m) => m.status === "planned" && m.scheduledFor)
    .sort((a, b) => a.scheduledFor!.localeCompare(b.scheduledFor!))[0];
  const tasks = await sql`
    select id, title, status, hypothesis, observation, client_approval, blocked_reason, blocked_note,
      target_url, after_state, coalesce(implemented_at, updated_at) as at
    from tasks
    where project_id = ${projectId} and client_visible and status != 'rejected'
    order by updated_at desc
  `;
  const why = (t: Record<string, unknown>): string | null =>
    (t.hypothesis as string | null) ?? (t.observation as string | null) ?? null;
  return {
    startsOn: e.startsOn,
    endsOn: e.endsOn,
    stage: e.stage,
    marketName: e.marketName,
    scopeSummary: e.scopeSummary,
    baseline: baseline
      ? {
          provider: baseline.provider,
          capturedAt: baseline.capturedAt,
          questionCount: baseline.questionCount,
          answerCount: baseline.answerCount,
          recommendedCount: baseline.subject.recommendedCount,
          distinctQuestions: baseline.subject.distinctQuestions,
          competitors: baseline.competitors.map((c) => ({ name: c.name, recommendedCount: c.recommendedCount })),
        }
      : null,
    latestMeasurement: latest
      ? {
          at: latest.frozenAt!,
          statement: latest.comparison?.statement ?? "This measurement used a different instrument than the baseline, so no before/after is claimed.",
          grade: latest.comparability?.grade ?? "not_comparable",
          reasons: latest.comparability?.reasons ?? [],
        }
      : null,
    nextMeasurementOn: planned?.scheduledFor ?? null,
    needsYourInput: tasks
      .filter((t) => t.clientApproval === "required" || t.blockedReason === "client_input" || t.blockedReason === "client_access")
      .map((t) => ({
        id: t.id as string,
        title: t.title as string,
        kind: t.clientApproval === "required" ? ("approval" as const) : t.blockedReason === "client_access" ? ("access" as const) : ("input" as const),
        detail: (t.blockedNote as string | null) ?? null,
        proposedChange: (t.afterState as string | null) ?? null,
        targetUrl: (t.targetUrl as string | null) ?? null,
        why: why(t),
      })),
    workingOn: tasks
      .filter((t) => (t.status === "in_progress" || t.status === "approved") && t.clientApproval !== "required")
      .map((t) => ({ id: t.id as string, title: t.title as string, why: why(t) })),
    changed: tasks
      .filter((t) => t.status === "done")
      .map((t) => ({
        id: t.id as string,
        title: t.title as string,
        at: t.at as Date,
        targetUrl: (t.targetUrl as string | null) ?? null,
        after: (t.afterState as string | null) ?? null,
        why: why(t),
      })),
  };
}
