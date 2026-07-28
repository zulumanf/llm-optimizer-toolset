import { sql } from "@/db/client";
import { getSubjectCompany } from "@/db/companies";

export interface TrendPoint {
  runId: string;
  runLabel: string;
  startedAt: Date;
  provider: string;
  value: number;
  scoringVersion: string;
  promptSetVersionId: string;
}

/** Authority-score history for the project's subject, per provider. */
export async function authorityTrend(projectId: string): Promise<TrendPoint[]> {
  const subject = await getSubjectCompany(projectId);
  if (!subject) return [];
  return sql<TrendPoint[]>`
    select r.id as run_id, r.label as run_label, r.started_at,
      s.provider, s.value, s.scoring_version, r.prompt_set_version_id
    from scores s
    join runs r on r.id = s.run_id
    where r.project_id = ${projectId} and s.company_id = ${subject.id}
      and s.metric = 'authority_score'
    order by r.started_at asc
  `;
}

export interface SelfTile {
  metric: string;
  value: number;
  sampleSize: number;
  previousValue: number | null;
}

/** Latest 'all' values for the project's subject + previous scored run. */
export async function selfTiles(projectId: string): Promise<SelfTile[]> {
  const subject = await getSubjectCompany(projectId);
  if (!subject) return [];
  const rows = await sql`
    with scored_runs as (
      select distinct r.id, r.started_at
      from runs r join scores s on s.run_id = r.id
      where r.project_id = ${projectId}
      order by r.started_at desc limit 2
    ),
    ranked as (
      select id, row_number() over (order by started_at desc) as rn
      from scored_runs
    )
    select s.metric, s.value, s.sample_size, ranked.rn
    from scores s
    join ranked on ranked.id = s.run_id
    where s.company_id = ${subject.id} and s.provider = 'all'
  `;
  const latest = rows.filter((r) => r.rn === "1" || Number(r.rn) === 1);
  const previous = new Map(
    rows
      .filter((r) => Number(r.rn) === 2)
      .map((r) => [r.metric as string, Number(r.value)])
  );
  return latest.map((r) => ({
    metric: r.metric as string,
    value: Number(r.value),
    sampleSize: r.sampleSize as number,
    previousValue: previous.get(r.metric as string) ?? null,
  }));
}

export interface HealthTile {
  lastRunLabel: string | null;
  lastRunStatus: string | null;
  pendingReviews: number;
  failedJobs: number;
}

export async function dataHealth(projectId: string): Promise<HealthTile> {
  const [lastRun] = await sql`
    select label, status from runs
    where project_id = ${projectId}
    order by started_at desc limit 1
  `;
  const [pending] = await sql`
    select count(*)::int as n
    from mentions m
    join responses r on r.id = m.response_id
    join runs on runs.id = r.run_id
    where runs.project_id = ${projectId} and m.needs_review
      and not exists (
        select 1 from mentions newer
        where newer.response_id = m.response_id
          and newer.company_id = m.company_id and newer.revision > m.revision
      )
  `;
  const [failed] = await sql`
    select count(*)::int as n from jobs where status = 'failed'
  `;
  return {
    lastRunLabel: (lastRun?.label as string) ?? null,
    lastRunStatus: (lastRun?.status as string) ?? null,
    pendingReviews: (pending?.n as number) ?? 0,
    failedJobs: (failed?.n as number) ?? 0,
  };
}
