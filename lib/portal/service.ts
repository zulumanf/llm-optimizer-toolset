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
