/**
 * Prospect benchmark reads (spec 032). A prospect benchmark is a link to an
 * existing run; every number shown comes from the `scores` rows the scoring
 * engine stored (provider='all', current scoring version) or from current-
 * revision `mentions` — nothing is recomputed here, so this surface can
 * never drift from what the measurement core published.
 */
import { sql } from "@/db/client";
import { SCORING_VERSION } from "@/lib/constants";
import type { BenchmarkEntityMetrics, AbsenceEvidence } from "@/lib/prospects/findings";

/** Cap evidence lists — enough to prove a pattern, small enough to render. */
const EVIDENCE_RESPONSE_LIMIT = 100;

/** Current revision = highest revision per (response, company). */
const CURRENT = sql`not exists (
  select 1 from mentions newer
  where newer.response_id = m.response_id
    and newer.company_id = m.company_id
    and newer.revision > m.revision
)`;

export interface RunSummary {
  id: string;
  label: string;
  status: string;
  providers: string[];
  startedAt: Date;
  completedAt: Date | null;
  responseCount: number;
  promptCount: number;
}

export async function runSummary(runId: string): Promise<RunSummary | null> {
  const rows = await sql`
    select r.id, r.label, r.status, r.providers, r.started_at, r.completed_at,
      (select count(*)::int from responses x where x.run_id = r.id and x.error is null)
        as response_count,
      (select count(distinct x.prompt_id)::int from responses x where x.run_id = r.id)
        as prompt_count
    from runs r where r.id = ${runId}
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id as string,
    label: row.label as string,
    status: row.status as string,
    providers: (row.providers as { provider: string }[]).map((p) => p.provider),
    startedAt: row.startedAt as Date,
    completedAt: (row.completedAt as Date) ?? null,
    responseCount: row.responseCount as number,
    promptCount: row.promptCount as number,
  };
}

/**
 * Cross-provider metrics for every company scored in the run, prospect
 * first when present. Missing metric = null, never 0.
 */
export async function scoredEntities(runId: string): Promise<BenchmarkEntityMetrics[]> {
  const rows = await sql`
    select s.company_id, c.name, s.metric, s.value, s.sample_size
    from scores s join companies c on c.id = s.company_id
    where s.run_id = ${runId} and s.provider = 'all'
      and s.scoring_version = ${SCORING_VERSION}
  `;
  const byCompany = new Map<string, BenchmarkEntityMetrics>();
  for (const row of rows) {
    const id = row.companyId as string;
    let entity = byCompany.get(id);
    if (!entity) {
      entity = {
        companyId: id,
        name: row.name as string,
        mentionRate: null,
        recommendationRate: null,
        shareOfVoice: null,
        citationScore: null,
        sampleSize: 0,
      };
      byCompany.set(id, entity);
    }
    const value = row.value === null ? null : Number(row.value);
    const n = Number(row.sampleSize ?? 0);
    entity.sampleSize = Math.max(entity.sampleSize, n);
    if (row.metric === "mention_rate") entity.mentionRate = value;
    else if (row.metric === "recommendation_rate") entity.recommendationRate = value;
    else if (row.metric === "share_of_voice") entity.shareOfVoice = value;
    else if (row.metric === "citation_score") entity.citationScore = value;
  }
  return [...byCompany.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Responses where a given rival was recommended and the prospect never mentioned. */
export async function absenceEvidence(
  runId: string,
  prospectCompanyId: string,
  competitorCompanyIds: string[]
): Promise<AbsenceEvidence[]> {
  const out: AbsenceEvidence[] = [];
  for (const rivalId of competitorCompanyIds) {
    const rows = await sql`
      select distinct m.response_id
      from mentions m
      join responses r on r.id = m.response_id
      where r.run_id = ${runId} and r.error is null
        and m.company_id = ${rivalId} and m.recommended and ${CURRENT}
        and not exists (
          select 1 from mentions pm
          where pm.response_id = m.response_id
            and pm.company_id = ${prospectCompanyId}
            and pm.mentioned
            and not exists (
              select 1 from mentions pn
              where pn.response_id = pm.response_id
                and pn.company_id = pm.company_id
                and pn.revision > pm.revision
            )
        )
      limit ${EVIDENCE_RESPONSE_LIMIT}
    `;
    out.push({
      competitorCompanyId: rivalId,
      responseIds: rows.map((r) => r.responseId as string),
    });
  }
  return out;
}

/** Valid responses in which the prospect was not mentioned at all. */
export async function prospectAbsentResponses(
  runId: string,
  prospectCompanyId: string
): Promise<string[]> {
  const rows = await sql`
    select r.id from responses r
    where r.run_id = ${runId} and r.error is null
      and not exists (
        select 1 from mentions m
        where m.response_id = r.id and m.company_id = ${prospectCompanyId}
          and m.mentioned and ${CURRENT}
      )
    limit ${EVIDENCE_RESPONSE_LIMIT}
  `;
  return rows.map((r) => r.id as string);
}

export interface PromptEvidence {
  responseId: string;
  promptText: string;
  provider: string;
  /** Companies recommended in this response, current revisions. */
  recommendedNames: string[];
}

/** Sanitized evidence excerpts for the audit page: prompt + who appeared. */
export async function promptEvidenceForResponses(
  responseIds: string[],
  limit: number
): Promise<PromptEvidence[]> {
  if (responseIds.length === 0) return [];
  const rows = await sql`
    select r.id as response_id, r.prompt_text, r.provider,
      coalesce(array_agg(c.name order by m.list_position nulls last)
        filter (where m.recommended), '{}') as recommended_names
    from responses r
    left join mentions m on m.response_id = r.id and ${CURRENT}
    left join companies c on c.id = m.company_id
    where r.id = any(${responseIds}::uuid[])
    group by r.id, r.prompt_text, r.provider
    order by r.prompt_text
    limit ${limit}
  `;
  return rows.map((r) => ({
    responseId: r.responseId as string,
    promptText: r.promptText as string,
    provider: r.provider as string,
    recommendedNames: (r.recommendedNames as string[]) ?? [],
  }));
}
