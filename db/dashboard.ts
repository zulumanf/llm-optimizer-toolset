import { sql } from "@/db/client";
import { getSubjectCompany } from "@/db/companies";
import { SCORING_VERSION } from "@/lib/constants";
import { CURRENT_REVISION } from "@/db/mentions";

export interface TrendPoint {
  runId: string;
  runLabel: string;
  startedAt: Date;
  provider: string;
  value: number;
  scoringVersion: string;
  promptSetVersionId: string;
}

/**
 * Authority-score history for the project's subject, per provider — current
 * scoring version only. Mixing versions in one trend line is exactly the
 * cross-version comparison lib/constants.ts forbids; a run scored only under
 * an older version drops out of the line rather than being silently blended.
 */
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
      and s.scoring_version = ${SCORING_VERSION}
    order by r.started_at asc
  `;
}

export interface SelfTile {
  metric: string;
  value: number;
  sampleSize: number;
  previousValue: number | null;
}

/** The most recent run with scores — the drill-down target for tiles. */
export async function latestScoredRunId(projectId: string): Promise<string | null> {
  const [row] = await sql`
    select r.id from runs r
    where r.project_id = ${projectId}
      and exists (select 1 from scores s where s.run_id = r.id)
    order by r.started_at desc limit 1
  `;
  return (row?.id as string | undefined) ?? null;
}

/** Latest 'all' values for the project's subject + previous scored run. */
export async function selfTiles(projectId: string): Promise<SelfTile[]> {
  const subject = await getSubjectCompany(projectId);
  if (!subject) return [];
  // Version-pinned throughout: the tile and its delta must compare a run to
  // its predecessor under the SAME scoring version, never across versions.
  const rows = await sql`
    with scored_runs as (
      select distinct r.id, r.started_at
      from runs r join scores s on s.run_id = r.id
      where r.project_id = ${projectId}
        and s.scoring_version = ${SCORING_VERSION}
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
      and s.scoring_version = ${SCORING_VERSION}
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

export interface SubjectScoreRow {
  runId: string;
  runLabel: string;
  startedAt: Date;
  metric: string;
  value: number;
  sampleSize: number;
}

/** Every 'all'-provider subject score across scored runs (current scoring
 * version), oldest first — one query powers baseline, current, and deltas.
 * The earliest scored run IS the baseline: derived, never marked or mutated. */
export async function subjectScoreHistory(
  projectId: string
): Promise<SubjectScoreRow[]> {
  const subject = await getSubjectCompany(projectId);
  if (!subject) return [];
  return sql<SubjectScoreRow[]>`
    select r.id as run_id, r.label as run_label, r.started_at,
      s.metric, s.value, s.sample_size
    from scores s
    join runs r on r.id = s.run_id
    where r.project_id = ${projectId} and s.company_id = ${subject.id}
      and s.provider = 'all' and s.scoring_version = ${SCORING_VERSION}
    order by r.started_at asc
  `;
}

export interface CitationSupport {
  validResponses: number;
  mentionedResponses: number;
  /** Mentioned answers that also cite a source NOT owned by the subject —
   * third-party or competitor-owned, never our own site posing as evidence. */
  independentlySupported: number;
}

export async function citationSupport(
  runId: string,
  companyId: string
): Promise<CitationSupport> {
  const [row] = await sql`
    select count(*)::int as valid_responses,
      count(*) filter (where m.mentioned)::int as mentioned_responses,
      count(*) filter (where m.mentioned and exists (
        select 1 from response_citations rc
        where rc.response_id = r.id
          and (rc.company_id is null or rc.company_id <> ${companyId})
      ))::int as independently_supported
    from responses r
    left join mentions m on m.response_id = r.id and m.company_id = ${companyId}
      -- authoritative revision: the ONE shared predicate (class-first, db/mentions.ts)
      and ${CURRENT_REVISION}
    where r.run_id = ${runId} and r.error is null
  `;
  return {
    validResponses: (row?.validResponses as number) ?? 0,
    mentionedResponses: (row?.mentionedResponses as number) ?? 0,
    independentlySupported: (row?.independentlySupported as number) ?? 0,
  };
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
      and ${CURRENT_REVISION}
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
