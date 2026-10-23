/**
 * Measurement v2 data access (spec 151): frozen competitor cohorts, pinned
 * measurement instruments, per-instrument score estimates. Every table here
 * is insert-only (migration 126 triggers); "changing" one means inserting the
 * next version.
 */
import { sql, type TransactionSql } from "@/db/client";

export interface CompetitorCohort {
  id: string;
  projectId: string;
  version: number;
  subjectCompanyId: string | null;
  companyIds: string[];
  reason: string;
  createdAt: Date;
}

export async function latestCohort(projectId: string): Promise<CompetitorCohort | null> {
  const [row] = await sql<CompetitorCohort[]>`
    select id, project_id, version, subject_company_id, company_ids, reason, created_at
    from competitor_cohorts where project_id = ${projectId}
    order by version desc limit 1
  `;
  return row ?? null;
}

/**
 * The cohort in force for a run: the latest version frozen at or before the
 * run STARTED. Rescoring an old run later never applies a cohort that did
 * not exist when it was measured (review finding H4); runs before any
 * cohort keep the v1.1 project universe.
 */
export async function cohortForRun(projectId: string, runStartedAt: Date): Promise<CompetitorCohort | null> {
  const [row] = await sql<CompetitorCohort[]>`
    select id, project_id, version, subject_company_id, company_ids, reason, created_at
    from competitor_cohorts where project_id = ${projectId} and created_at <= ${runStartedAt}
    order by version desc limit 1
  `;
  return row ?? null;
}

export async function listCohorts(projectId: string): Promise<CompetitorCohort[]> {
  return sql<CompetitorCohort[]>`
    select id, project_id, version, subject_company_id, company_ids, reason, created_at
    from competitor_cohorts where project_id = ${projectId}
    order by version desc
  `;
}

export async function insertCohort(
  tx: TransactionSql | typeof sql,
  input: { projectId: string; subjectCompanyId: string | null; companyIds: string[]; reason: string; createdBy: string | null }
): Promise<CompetitorCohort> {
  const [row] = await tx<CompetitorCohort[]>`
    insert into competitor_cohorts (project_id, version, subject_company_id, company_ids, reason, created_by)
    values (
      ${input.projectId},
      coalesce((select max(version) from competitor_cohorts where project_id = ${input.projectId}), 0) + 1,
      ${input.subjectCompanyId}, ${input.companyIds}, ${input.reason}, ${input.createdBy}
    )
    returning id, project_id, version, subject_company_id, company_ids, reason, created_at
  `;
  return row as CompetitorCohort;
}

/** Active (non-archived) competitors plus the subject — the cohort source. */
export async function currentCohortMembers(projectId: string): Promise<{ subjectId: string | null; companyIds: string[] }> {
  const [project] = await sql`select subject_company_id from projects where id = ${projectId}`;
  const subjectId = (project?.subjectCompanyId as string | null) ?? null;
  const rows = await sql`
    select company_id from competitors
    where project_id = ${projectId} and archived_at is null
    order by company_id
  `;
  const ids = rows.map((r) => r.companyId as string);
  const all = subjectId ? [subjectId, ...ids.filter((id) => id !== subjectId)] : ids;
  return { subjectId, companyIds: all };
}

export interface InstrumentProvider {
  provider: string;
  model: string;
  repetitions: number;
}

export interface MeasurementInstrument {
  id: string;
  projectId: string;
  version: number;
  providers: InstrumentProvider[];
  locationContext: string;
  reason: string;
  createdAt: Date;
}

export async function pinnedInstrument(projectId: string): Promise<MeasurementInstrument | null> {
  const [row] = await sql<MeasurementInstrument[]>`
    select id, project_id, version, providers, location_context, reason, created_at
    from measurement_instruments where project_id = ${projectId}
    order by version desc limit 1
  `;
  return row ?? null;
}

export async function insertInstrument(
  tx: TransactionSql | typeof sql,
  input: { projectId: string; providers: InstrumentProvider[]; reason: string; createdBy: string | null }
): Promise<MeasurementInstrument> {
  const [row] = await tx<MeasurementInstrument[]>`
    insert into measurement_instruments (project_id, version, providers, reason, created_by)
    values (
      ${input.projectId},
      coalesce((select max(version) from measurement_instruments where project_id = ${input.projectId}), 0) + 1,
      ${tx.json(input.providers as never)}, ${input.reason}, ${input.createdBy}
    )
    returning id, project_id, version, providers, location_context, reason, created_at
  `;
  return row as MeasurementInstrument;
}

export interface ScoreEstimateRow {
  runId: string;
  companyId: string;
  metric: string;
  provider: string;
  model: string;
  instrumentKey: string;
  servedModels: string[];
  numerator: number;
  denominator: number;
  distinctPrompts: number;
  excludedEcho: number;
  rate: number | null;
  wilsonLow: number | null;
  wilsonHigh: number | null;
  clusteredLow: number | null;
  clusteredHigh: number | null;
  icc: number | null;
  cohortId: string | null;
  scoringVersion: string;
  computedAt: Date;
}

const ESTIMATE_COLUMNS = sql`
  run_id, company_id, metric, provider, model, instrument_key, served_models,
  numerator, denominator, distinct_prompts, excluded_echo,
  rate::float8 as rate, wilson_low::float8 as wilson_low, wilson_high::float8 as wilson_high,
  clustered_low::float8 as clustered_low, clustered_high::float8 as clustered_high,
  icc::float8 as icc, cohort_id, scoring_version, computed_at
`;

export async function estimatesForRun(runId: string, scoringVersion: string): Promise<ScoreEstimateRow[]> {
  return sql<ScoreEstimateRow[]>`
    select ${ESTIMATE_COLUMNS} from score_estimates
    where run_id = ${runId} and scoring_version = ${scoringVersion}
    order by company_id, metric, instrument_key
  `;
}

export async function estimatesForRuns(runIds: string[], scoringVersion: string): Promise<ScoreEstimateRow[]> {
  if (runIds.length === 0) return [];
  return sql<ScoreEstimateRow[]>`
    select ${ESTIMATE_COLUMNS} from score_estimates
    where run_id = any(${runIds}) and scoring_version = ${scoringVersion}
    order by run_id, company_id, metric, instrument_key
  `;
}

export interface NamedEstimateRow extends ScoreEstimateRow {
  companyName: string;
  isSubject: boolean;
}

/** Estimates for display, subject first. */
export async function namedEstimatesForRun(runId: string, scoringVersion: string): Promise<NamedEstimateRow[]> {
  return sql<NamedEstimateRow[]>`
    select ${ESTIMATE_COLUMNS}, c.name as company_name,
      (c.id = p.subject_company_id) as is_subject
    from score_estimates e
    join companies c on c.id = e.company_id
    join runs r on r.id = e.run_id
    join projects p on p.id = r.project_id
    where e.run_id = ${runId} and e.scoring_version = ${scoringVersion}
    order by (c.id = p.subject_company_id) desc, c.name, e.metric, e.instrument_key
  `;
}
