/**
 * Prospect benchmark reads (spec 032). A prospect benchmark is a link to an
 * existing run; every number shown comes from the `scores` rows the scoring
 * engine stored (provider='all', current scoring version) or from current-
 * revision `mentions` — nothing is recomputed here, so this surface can
 * never drift from what the measurement core published.
 */
import { sql } from "@/db/client";
import { SCORING_VERSION } from "@/lib/constants";
import { PROMPT_NAMES_COMPANY } from "@/lib/scoring/prompt-echo";
import type { BenchmarkEntityMetrics, AbsenceEvidence } from "@/lib/prospects/findings";
import { CURRENT_REVISION } from "@/db/mentions";
import {
  valuableVisibilityFromCells,
  type ValuableVisibility,
} from "@/lib/scoring/valuable";

/** Cap evidence lists — enough to prove a pattern, small enough to render. */
const EVIDENCE_RESPONSE_LIMIT = 100;

/** Current revision = highest revision per (response, company). Exported
 * (simplify pass 2026-08-14): publishAudit's stakes and excerpt queries
 * inlined verbatim copies of this safety-critical idiom. Correlates on a
 * `mentions m` alias in the consuming query. */
export const CURRENT = sql`${CURRENT_REVISION}`;

export interface RunSummary {
  id: string;
  label: string;
  status: string;
  statusDetail: string | null;
  providers: string[];
  startedAt: Date;
  completedAt: Date | null;
  responseCount: number;
  /** Prompts with at least one VALID capture (launch fix 2026-08-14): the
   * audit page claims "we asked N questions", so a prompt whose every cell
   * errored must not be counted as asked-and-answered. */
  promptCount: number;
  /** Cells that errored — the run-health gate's evidence. */
  failedCount: number;
}

export async function runSummary(runId: string): Promise<RunSummary | null> {
  const rows = await sql`
    select r.id, r.label, r.status, r.status_detail, r.providers,
      r.started_at, r.completed_at,
      (select count(*)::int from responses x where x.run_id = r.id and x.error is null)
        as response_count,
      (select count(distinct x.prompt_id)::int from responses x
        where x.run_id = r.id and x.error is null)
        as prompt_count,
      (select count(*)::int from responses x where x.run_id = r.id and x.error is not null)
        as failed_count
    from runs r where r.id = ${runId}
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id as string,
    label: row.label as string,
    status: row.status as string,
    statusDetail: (row.statusDetail as string | null) ?? null,
    providers: (row.providers as { provider: string }[]).map((p) => p.provider),
    startedAt: row.startedAt as Date,
    completedAt: (row.completedAt as Date) ?? null,
    responseCount: row.responseCount as number,
    promptCount: row.promptCount as number,
    failedCount: row.failedCount as number,
  };
}

/**
 * Cross-provider metrics for every company scored in the run, prospect
 * first when present. Missing metric = null, never 0.
 */
export async function scoredEntities(runId: string): Promise<BenchmarkEntityMetrics[]> {
  const rows = await sql`
    select s.id as score_id, s.company_id, c.name, s.metric, s.value, s.sample_size
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
        scoreIds: {},
      };
      byCompany.set(id, entity);
    }
    const value = row.value === null ? null : Number(row.value);
    const n = Number(row.sampleSize ?? 0);
    entity.sampleSize = Math.max(entity.sampleSize, n);
    entity.scoreIds[row.metric as string] = row.scoreId as string;
    if (row.metric === "mention_rate") entity.mentionRate = value;
    else if (row.metric === "recommendation_rate") entity.recommendationRate = value;
    else if (row.metric === "share_of_voice") entity.shareOfVoice = value;
    else if (row.metric === "citation_score") entity.citationScore = value;
  }
  return [...byCompany.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Valuable visibility for one company over a run (spec 038): every valid,
 * non-holdout response is a cell carrying its frozen prompt's intent
 * (tier precedence, category fallback), whether the prompt named the company
 * (echo — excluded, the gap detector's organic rule), and the current-revision
 * mention. The math lives in lib/scoring/valuable.ts; this only assembles.
 */
export async function valuableVisibility(
  runId: string,
  companyId: string
): Promise<ValuableVisibility> {
  const rows = await sql`
    with fp as (
      select p."promptId" as prompt_id, p.category, p.tier,
        coalesce(p."isHoldout", false) as is_holdout
      from runs r2
      join prompt_set_versions v on v.id = r2.prompt_set_version_id,
      -- frozen_prompts keys are camelCase (lib/prompts/types.ts)
      jsonb_to_recordset(v.frozen_prompts)
        as p("promptId" uuid, category text, tier int, "isHoldout" boolean)
      where r2.id = ${runId}
    )
    select fp.category, fp.tier,
      coalesce(
        (select ${PROMPT_NAMES_COMPANY} from companies c where c.id = ${companyId}),
        false
      ) as prompt_named_company,
      coalesce(m.mentioned, false) as mentioned,
      coalesce(m.recommended, false) as recommended,
      m.list_position
    from responses r
    join fp on fp.prompt_id = r.prompt_id
    left join mentions m on m.response_id = r.id and m.company_id = ${companyId}
      and ${CURRENT}
    where r.run_id = ${runId} and r.error is null and not fp.is_holdout
  `;
  return valuableVisibilityFromCells(
    rows.map((r) => ({
      tier: r.tier === null || r.tier === undefined ? null : Number(r.tier),
      category: (r.category as string | null) ?? null,
      promptNamedCompany: r.promptNamedCompany as boolean,
      mentioned: r.mentioned as boolean,
      recommended: r.recommended as boolean,
      listPosition:
        r.listPosition === null || r.listPosition === undefined
          ? null
          : Number(r.listPosition),
    }))
  );
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
