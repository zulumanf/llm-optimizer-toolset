import { sql } from "@/db/client";
import { getSubjectCompany } from "@/db/companies";
import { SCORING_VERSION } from "@/lib/constants";

export interface CompetitorRow {
  id: string;
  companyId: string;
  companyName: string;
  isSelf: boolean;
  tier: "primary" | "secondary" | "self";
  addedAt: Date | null;
}

export interface BrandCandidate {
  id: string;
  name: string;
  hitCount: number;
  lastSeenAt: Date;
}

/** The project's subject (implicitly compared) plus tracked competitors. */
export async function listComparisonCompanies(
  projectId: string
): Promise<CompetitorRow[]> {
  const subject = await getSubjectCompany(projectId);
  return sql<CompetitorRow[]>`
    select null::uuid as id, c.id as company_id, c.name as company_name,
      true as is_self, 'self' as tier, null::timestamptz as added_at
    from companies c
    where c.id = ${subject?.id ?? null} and c.archived_at is null
    union all
    select k.id, c.id, c.name, false, k.tier, k.added_at
    from competitors k
    join companies c on c.id = k.company_id
    where k.project_id = ${projectId} and k.archived_at is null
      and c.archived_at is null and c.id != ${subject?.id ?? null}
    order by is_self desc, company_name asc
  `;
}

/** Latest scored run's metric values per company (provider = 'all'),
 * pinned to the current scoring version — a comparison matrix mixing
 * versions across companies would be the forbidden cross-version read. */
export async function latestScoresByCompany(
  projectId: string
): Promise<Map<string, Record<string, number>>> {
  const rows = await sql`
    select s.company_id, s.metric, s.value
    from scores s
    where s.provider = 'all'
      and s.scoring_version = ${SCORING_VERSION}
      and s.run_id = (
        select r.id from runs r
        join scores s2 on s2.run_id = r.id
        where r.project_id = ${projectId}
          and s2.scoring_version = ${SCORING_VERSION}
        order by r.started_at desc
        limit 1
      )
  `;
  const map = new Map<string, Record<string, number>>();
  for (const row of rows) {
    const companyId = row.companyId as string;
    if (!map.has(companyId)) map.set(companyId, {});
    map.get(companyId)![row.metric as string] = Number(row.value);
  }
  return map;
}

export interface TopSource {
  domain: string;
  citationCount: number;
  sourceType: string | null;
  relationship: string | null;
  attributedCompany: string | null;
}

/** Which sources the answer engines actually lean on for this client —
 * aggregated per domain from the project-scoped registry (spec 030 batch 2,
 * roadmap 2.2). */
export async function listTopSources(
  projectId: string,
  limit = 15
): Promise<TopSource[]> {
  return sql<TopSource[]>`
    select s.domain,
      sum(s.citation_count)::int as citation_count,
      min(s.source_type) as source_type,
      min(s.relationship) as relationship,
      min(c.name) as attributed_company
    from sources s
    left join companies c on c.id = s.company_id
    where s.project_id = ${projectId}
    group by s.domain
    order by citation_count desc, s.domain asc
    limit ${limit}
  `;
}

export async function listBrandCandidates(
  projectId: string,
  minHits: number
): Promise<BrandCandidate[]> {
  // Project-scoped (migration 029): which brands surface in a client's
  // answers is that client's competitive intelligence, not shared telemetry.
  return sql<BrandCandidate[]>`
    select id, name, hit_count, last_seen_at
    from brand_candidates
    where project_id = ${projectId}
      and dismissed_at is null and promoted_company_id is null
      and hit_count >= ${minHits}
    order by hit_count desc, last_seen_at desc
    limit 20
  `;
}
