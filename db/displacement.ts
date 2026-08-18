/**
 * Read queries for recommendation displacement (spec 087). Displacement is
 * derived on read from the immutable response/mention/citation ledgers —
 * these queries only ever SELECT.
 */
import { sql } from "@/db/client";
import { PROMPT_NAMES_COMPANY } from "@/lib/scoring/prompt-echo";

export interface ValidResponseRow {
  id: string;
  provider: string;
  promptId: string;
}

/** Valid = the observation succeeded. Refusals count; errors never do. */
export async function validResponsesForRun(
  runId: string
): Promise<ValidResponseRow[]> {
  return sql<ValidResponseRow[]>`
    select id, provider, prompt_id
    from responses
    where run_id = ${runId} and error is null
  `;
}

export interface RunMentionRow {
  responseId: string;
  companyId: string;
  companyName: string;
  mentioned: boolean;
  recommended: boolean;
  listPosition: number | null;
  /** The prompt itself named this company (echo rule, lib/scoring/prompt-echo). */
  promptEchoed: boolean;
}

/** Current-revision mentions for a run's valid responses, with the echo flag. */
export async function currentMentionsWithEcho(
  runId: string
): Promise<RunMentionRow[]> {
  return sql<RunMentionRow[]>`
    select m.response_id, m.company_id, c.name as company_name,
      m.mentioned, m.recommended, m.list_position,
      ${PROMPT_NAMES_COMPANY} as prompt_echoed
    from mentions m
    join responses r on r.id = m.response_id
    join companies c on c.id = m.company_id
    where r.run_id = ${runId}
      and r.error is null
      and not exists (
        select 1 from mentions newer
        where newer.response_id = m.response_id
          and newer.company_id = m.company_id
          and newer.revision > m.revision
      )
  `;
}

export interface ResponseCitationRow {
  responseId: string;
  domain: string;
}

/** Citation domains (in-text ∪ search) for a set of responses, deduped per
 * (response, domain). */
export async function citationDomainsForResponses(
  responseIds: string[]
): Promise<ResponseCitationRow[]> {
  if (responseIds.length === 0) return [];
  return sql<ResponseCitationRow[]>`
    select distinct response_id, domain
    from response_citations
    where response_id = any(${responseIds})
  `;
}

export interface DomainClassificationRow {
  domain: string;
  sourceType: string | null;
  relationship: string | null;
}

/** Project-scoped source classifications for a set of domains. Sources are
 * one row per (project, url), so a domain can carry several rows — collapse
 * to the first classified value per domain. */
export async function domainClassifications(
  projectId: string,
  domains: string[]
): Promise<DomainClassificationRow[]> {
  if (domains.length === 0) return [];
  return sql<DomainClassificationRow[]>`
    select domain,
      (array_agg(source_type) filter (where source_type is not null))[1]
        as source_type,
      (array_agg(relationship) filter (where relationship is not null))[1]
        as relationship
    from sources
    where project_id = ${projectId} and domain = any(${domains})
    group by domain
  `;
}
