import { sql } from "@/db/client";
import { CURRENT_REVISION } from "@/db/mentions";

/**
 * Market-level citation aggregation (spec 086): the raw rows behind "which
 * sources do AI answers in this market rely on". Every number is a count of
 * immutable response_citations rows over the benchmark runs of a launch's
 * prospects — failed responses never carry citations (the ledger derives
 * from captured payloads), and the totals query re-asserts `error is null`
 * so shares always use the valid-measurement denominator.
 */

export interface MarketDomainAggRow {
  domain: string;
  citations: number;
  responsesCiting: number;
  runsCiting: number;
  providers: string[];
}

export interface MarketCitationUrlRow {
  domain: string;
  url: string;
  citations: number;
}

export interface MarketDomainMentionRow {
  domain: string;
  companyId: string;
  companyName: string;
  mentions: number;
  recommendations: number;
}

export interface MarketCitationTotals {
  responses: number;
  citations: number;
  runs: number;
}

export async function marketDomainAggregates(
  projectIds: string[]
): Promise<MarketDomainAggRow[]> {
  return sql<MarketDomainAggRow[]>`
    select rc.domain,
      count(*)::int as citations,
      count(distinct rc.response_id)::int as responses_citing,
      count(distinct r.run_id)::int as runs_citing,
      array_agg(distinct r.provider) as providers
    from response_citations rc
    join responses r on r.id = rc.response_id
    where r.run_id in (select id from runs where project_id = any(${projectIds}))
      and r.error is null
    group by rc.domain
    order by citations desc, rc.domain asc
  `;
}

export async function marketCitationTotals(
  projectIds: string[]
): Promise<MarketCitationTotals> {
  const [row] = await sql`
    select
      (select count(*)::int from responses r
        where r.run_id in (select id from runs where project_id = any(${projectIds}))
          and r.error is null) as responses,
      (select count(*)::int from response_citations rc
        join responses r on r.id = rc.response_id
        where r.run_id in (select id from runs where project_id = any(${projectIds}))
          and r.error is null) as citations,
      (select count(distinct r.run_id)::int from responses r
        where r.run_id in (select id from runs where project_id = any(${projectIds}))
          and r.error is null) as runs
  `;
  return {
    responses: (row?.responses as number) ?? 0,
    citations: (row?.citations as number) ?? 0,
    runs: (row?.runs as number) ?? 0,
  };
}

/** Top cited pages, restricted to the given domains. */
export async function marketCitationUrls(
  projectIds: string[],
  domains: string[]
): Promise<MarketCitationUrlRow[]> {
  return sql<MarketCitationUrlRow[]>`
    select rc.domain, rc.url, count(*)::int as citations
    from response_citations rc
    join responses r on r.id = rc.response_id
    where r.run_id in (select id from runs where project_id = any(${projectIds}))
      and r.error is null
      and rc.domain = any(${domains})
    group by rc.domain, rc.url
    order by rc.domain asc, citations desc, rc.url asc
  `;
}

/**
 * Who appears in the answers that cite each domain — CURRENT-revision
 * mentions co-occurring with a citation of that domain in the same response.
 * Co-occurrence by construction (the spec-036 wording): "mentioned in an
 * answer that cited X", never "mentioned because of X".
 */
export async function marketDomainMentions(
  projectIds: string[],
  domains: string[]
): Promise<MarketDomainMentionRow[]> {
  return sql<MarketDomainMentionRow[]>`
    select rc.domain, m.company_id, c.name as company_name,
      count(distinct m.response_id) filter (where m.mentioned)::int as mentions,
      count(distinct m.response_id) filter (where m.recommended)::int as recommendations
    from response_citations rc
    join responses r on r.id = rc.response_id
    join mentions m on m.response_id = r.id
    join companies c on c.id = m.company_id
    where r.run_id in (select id from runs where project_id = any(${projectIds}))
      and r.error is null
      and rc.domain = any(${domains})
      and ${CURRENT_REVISION}
    group by rc.domain, m.company_id, c.name
    having count(distinct m.response_id) filter (where m.mentioned) > 0
    order by rc.domain asc, recommendations desc, mentions desc, company_name asc
  `;
}
