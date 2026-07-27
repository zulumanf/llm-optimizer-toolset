import { sql } from "@/db/client";

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

/** Parva (implicitly compared) plus the project's tracked competitors. */
export async function listComparisonCompanies(
  projectId: string
): Promise<CompetitorRow[]> {
  return sql<CompetitorRow[]>`
    select null::uuid as id, c.id as company_id, c.name as company_name,
      true as is_self, 'self' as tier, null::timestamptz as added_at
    from companies c
    where c.is_self and c.archived_at is null
    union all
    select k.id, c.id, c.name, false, k.tier, k.added_at
    from competitors k
    join companies c on c.id = k.company_id
    where k.project_id = ${projectId} and k.archived_at is null
      and c.archived_at is null
    order by is_self desc, company_name asc
  `;
}

/** Latest scored run's metric values per company (provider = 'all'). */
export async function latestScoresByCompany(
  projectId: string
): Promise<Map<string, Record<string, number>>> {
  const rows = await sql`
    select s.company_id, s.metric, s.value
    from scores s
    where s.provider = 'all'
      and s.run_id = (
        select r.id from runs r
        join scores s2 on s2.run_id = r.id
        where r.project_id = ${projectId}
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

export async function listBrandCandidates(minHits: number): Promise<BrandCandidate[]> {
  return sql<BrandCandidate[]>`
    select id, name, hit_count, last_seen_at
    from brand_candidates
    where dismissed_at is null and promoted_company_id is null
      and hit_count >= ${minHits}
    order by hit_count desc, last_seen_at desc
    limit 20
  `;
}
