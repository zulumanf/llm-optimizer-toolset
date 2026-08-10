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
