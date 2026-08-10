/**
 * Entity-relationship rollup (roadmap 2.3). The knowledge graph knows "this
 * agent works for that brokerage" (approved entity_relationships); the
 * measurement registry scores them as unrelated companies. This bridges the
 * two — read-only, at read time — so an agent's and their brokerage's
 * visibility can be seen as one commercial footprint.
 *
 * The group rate is NOT the sum of member rates: the same response often
 * mentions both. It is distinct responses mentioning ANY member over the
 * run's stored sample basis — re-derived from mention rows, the same
 * arithmetic the drill-down uses.
 */
import { sql } from "@/db/client";

const GROUPING_RELATIONSHIPS = ["works_for", "brokerage", "affiliated_with"];

export interface EntityGroupMember {
  companyId: string;
  name: string;
  relationshipType: string;
  mentionRate: number | null;
}

export interface EntityGroup {
  parentCompanyId: string;
  parentName: string;
  members: EntityGroupMember[];
  /** Distinct responses mentioning any member (incl. parent) / sample. */
  groupMentionRate: number | null;
  sampleSize: number | null;
}

export async function relationshipGroups(
  projectId: string
): Promise<EntityGroup[]> {
  // Approved relationships whose BOTH endpoints resolve to companies this
  // project measures (subject or tracked competitor).
  const links = await sql`
    select
      child.company_id as child_company_id, cc.name as child_name,
      parent.company_id as parent_company_id, pc.name as parent_name,
      r.relationship_type
    from entity_relationships r
    join knowledge_entities child on child.id = r.from_entity_id
    join knowledge_entities parent on parent.id = r.to_entity_id
    join companies cc on cc.id = child.company_id
    join companies pc on pc.id = parent.company_id
    where r.status = 'approved'
      -- Effective dating (spec 056): an ended affiliation no longer groups.
      and (r.effective_until is null or r.effective_until >= current_date)
      and r.relationship_type = any(${GROUPING_RELATIONSHIPS})
      and (r.project_id is null or r.project_id = ${projectId})
      and child.company_id is not null and parent.company_id is not null
  `;
  if (links.length === 0) return [];

  const [latestRun] = await sql`
    select r.id from runs r
    where r.project_id = ${projectId}
      and exists (select 1 from scores s where s.run_id = r.id)
    order by r.started_at desc limit 1
  `;

  const byParent = new Map<string, EntityGroup>();
  for (const link of links) {
    const parentId = link.parentCompanyId as string;
    if (!byParent.has(parentId)) {
      byParent.set(parentId, {
        parentCompanyId: parentId,
        parentName: link.parentName as string,
        members: [],
        groupMentionRate: null,
        sampleSize: null,
      });
    }
    byParent.get(parentId)!.members.push({
      companyId: link.childCompanyId as string,
      name: link.childName as string,
      relationshipType: link.relationshipType as string,
      mentionRate: null,
    });
  }

  if (!latestRun) return [...byParent.values()];

  for (const group of byParent.values()) {
    const memberIds = [
      group.parentCompanyId,
      ...group.members.map((m) => m.companyId),
    ];
    const rates = await sql`
      select company_id, value, sample_size from scores
      where run_id = ${latestRun.id} and metric = 'mention_rate'
        and provider = 'all' and company_id = any(${memberIds})
    `;
    for (const member of group.members) {
      const row = rates.find((r) => r.companyId === member.companyId);
      member.mentionRate = row ? Number(row.value) : null;
    }
    const sampleSize = rates[0] ? Number(rates[0].sampleSize) : null;
    if (sampleSize && sampleSize > 0) {
      const [mentioned] = await sql`
        select count(distinct m.response_id)::int as n
        from mentions m
        join responses resp on resp.id = m.response_id
        where resp.run_id = ${latestRun.id}
          and m.company_id = any(${memberIds})
          and m.mentioned
          and not exists (select 1 from mentions newer
            where newer.response_id = m.response_id
              and newer.company_id = m.company_id
              and newer.revision > m.revision)
      `;
      group.groupMentionRate = Number(mentioned?.n ?? 0) / sampleSize;
      group.sampleSize = sampleSize;
    }
  }

  return [...byParent.values()];
}
