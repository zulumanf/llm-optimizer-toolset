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
}

const HEADLINE_METRICS = [
  "mention_rate",
  "recommendation_rate",
  "first_position_rate",
];

export async function portalOverview(projectId: string): Promise<PortalOverview> {
  const subject = await getSubjectCompany(projectId);
  if (!subject) {
    return { subjectName: null, headlines: [], trend: [], lastMeasuredAt: null };
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
  };
}

export interface PortalWorkItem {
  kind: "task" | "content" | "intervention";
  title: string;
  at: Date;
  detail: string | null;
}

/** Proof of work: ONLY client_visible completed tasks, published content,
 * and interventions. Owner identities and internal notes never leave. */
export async function portalWork(projectId: string): Promise<PortalWorkItem[]> {
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
  const interventions = await sql`
    select title, shipped_at as at from interventions
    where project_id = ${projectId} and archived_at is null
    order by shipped_at desc limit 50
  `;
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
      detail: "Shipped — remeasured on schedule",
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

export async function portalReports(projectId: string): Promise<PortalReport[]> {
  return sql<PortalReport[]>`
    select id, title, kind, period_start::text, period_end::text, published_at
    from reports
    where project_id = ${projectId} and status = 'published'
    order by published_at desc
  `;
}
