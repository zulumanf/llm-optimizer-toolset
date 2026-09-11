import { sql } from "@/db/client";
import { CURRENT_REVISION } from "@/db/mentions";

export interface RecommendedCitationRow {
  companyId: string;
  domain: string;
  citations: number;
}

/**
 * Citation domains per recommended company for one run (spec 036): the
 * domains of response_citations rows on responses whose CURRENT mention of
 * that company says recommended. Co-occurrence by construction — the join
 * says "cited in the same answer", nothing more.
 */
export async function recommendedCitationDomains(
  runId: string
): Promise<RecommendedCitationRow[]> {
  return sql<RecommendedCitationRow[]>`
    select m.company_id, c.domain, count(*)::int as citations
    from mentions m
    join responses r on r.id = m.response_id
    join response_citations c on c.response_id = r.id
    where r.run_id = ${runId}
      and m.recommended
      and ${CURRENT_REVISION}
    group by m.company_id, c.domain
    order by m.company_id, citations desc, c.domain asc
  `;
}

export interface DomainLabelRow {
  domain: string;
  sourceType: string | null;
  relationship: string | null;
}

/** Type/relationship labels from the project's sources registry, one row
 * per domain (a domain's pages share a classification in practice). */
export async function domainLabelsForProject(
  projectId: string
): Promise<DomainLabelRow[]> {
  return sql<DomainLabelRow[]>`
    select domain, min(source_type) as source_type, min(relationship) as relationship
    from sources
    where project_id = ${projectId}
    group by domain
  `;
}
