/**
 * Weekly deeper review (spec 025).
 *
 * The daily job asks "is anything broken?". These ask "is anything *rotting*?"
 * — which is slower, costlier, and produces findings that are judgements
 * rather than faults. None of them blocks anything; all of them produce
 * exceptions a human triages.
 *
 * Several checks here measure the knowledge layer's own usefulness rather than
 * its correctness: whether hot files are actually selected into packets,
 * whether pages are ever read, whether operators override what the builder
 * chose. A layer that is correct but unused is still a failure, and nothing
 * else in the system would report it.
 */
import { sql } from "@/db/client";
import {
  OVERSIZED_PAGE_FACTOR,
  UNUSED_PAGE_DAYS,
  WEAK_EVIDENCE_MAX_SOURCES,
} from "@/lib/knowledge/constants";
import {
  scope,
  type DetectorResult,
  type Finding,
} from "@/lib/knowledge/maintenance/detectors";

// ------------------------------------------------------- duplicate entities

/**
 * Entities sharing a normalized alias. Two rows for one real-world firm split
 * its evidence in half, so neither side looks well-supported and both compile
 * into different pages.
 */
export async function reviewDuplicateEntities(
  projectId: string | null
): Promise<DetectorResult> {
  const rows = await sql`
    select a.normalized_alias, array_agg(distinct a.entity_id::text) as entity_ids,
      count(distinct a.entity_id) as n
    from entity_aliases a
    join knowledge_entities e on e.id = a.entity_id
    where true ${projectId ? sql`and e.project_id = ${projectId}` : sql``}
    group by a.normalized_alias
    having count(distinct a.entity_id) > 1
  `;
  const [total] = await sql`
    select count(*)::int as n from knowledge_entities where true ${scope(projectId)}
  `;
  return {
    kind: "duplicate_entity",
    considered: Number(total?.n ?? 0),
    findings: rows.map((row) => ({
      subjectType: "entity_alias",
      subjectId: null,
      projectId,
      summary: `${row.n} entities share the alias "${row.normalizedAlias}"`,
      detail: { alias: row.normalizedAlias, entityIds: row.entityIds },
      recommendedAction:
        "Merge them if they are the same entity. Split evidence makes both look weakly supported.",
    })),
  };
}

// ----------------------------------------------------------- weak evidence

/** Approved claims resting on a single source. */
export async function reviewWeakEvidence(
  projectId: string | null
): Promise<DetectorResult> {
  const rows = await sql`
    select id, project_id, key, category, cardinality(evidence_ids) as n
    from claims
    where status = 'approved'
      and cardinality(evidence_ids) > 0
      and cardinality(evidence_ids) <= ${WEAK_EVIDENCE_MAX_SOURCES}
      ${scope(projectId)}
  `;
  const [total] = await sql`
    select count(*)::int as n from claims where status = 'approved' ${scope(projectId)}
  `;
  return {
    kind: "weak_evidence",
    considered: Number(total?.n ?? 0),
    findings: rows.map((row) => ({
      subjectType: "claim",
      subjectId: row.id as string,
      projectId: (row.projectId as string | null) ?? null,
      summary: `Claim "${row.key}" rests on a single source`,
      detail: { key: row.key, category: row.category, sourceCount: Number(row.n ?? 0) },
      recommendedAction:
        "Corroborate with a second independent source, or mark the claim as single-sourced so packets can disclose it.",
      // A high-risk claim on one source is materially different from an
      // ordinary one; the category decides how loud this is.
      severity: HIGH_RISK.has(String(row.category)) ? ("high" as const) : undefined,
    })),
  };
}

const HIGH_RISK = new Set([
  "sales_volume",
  "ranking",
  "award",
  "market_position",
  "team_leadership",
  "brokerage_affiliation",
]);

// ---------------------------------------------------------- oversized pages

export async function reviewOversizedPages(
  projectId: string | null
): Promise<DetectorResult> {
  const rows = await sql`
    select p.id, p.project_id, p.slug, p.token_budget, v.token_count
    from wiki_pages p
    join wiki_page_versions v on v.id = p.active_version_id
    where p.token_budget is not null
      and v.token_count > p.token_budget * ${OVERSIZED_PAGE_FACTOR}
      ${projectId ? sql`and p.project_id = ${projectId}` : sql``}
  `;
  const [total] = await sql`
    select count(*)::int as n from wiki_pages
    where active_version_id is not null ${scope(projectId)}
  `;
  return {
    kind: "oversized_page",
    considered: Number(total?.n ?? 0),
    findings: rows.map((row) => ({
      subjectType: "wiki_page",
      subjectId: row.id as string,
      projectId: (row.projectId as string | null) ?? null,
      summary: `Page "${row.slug}" is ${row.tokenCount} tokens against a ${row.tokenBudget} budget`,
      detail: {
        slug: row.slug,
        tokenCount: Number(row.tokenCount ?? 0),
        tokenBudget: Number(row.tokenBudget ?? 0),
      },
      recommendedAction:
        "Compact the template. A hot file over budget stops being the cheap default it exists to be.",
    })),
  };
}

// ------------------------------------------------------------ unused pages

/**
 * Pages never selected into a packet. Compiling and storing a page nobody
 * reads is pure cost, and it dilutes the retrieval candidate set.
 */
export async function reviewUnusedPages(
  projectId: string | null
): Promise<DetectorResult> {
  const rows = await sql`
    select p.id, p.project_id, p.slug, p.page_type
    from wiki_pages p
    where p.active_version_id is not null
      and not exists (
        select 1 from context_packet_items i
        join evidence_packets ep on ep.id = i.packet_id
        where i.item_type in ('wiki_section', 'hot_file')
          and i.item_ref = p.slug
          and ep.built_at > now() - make_interval(days => ${UNUSED_PAGE_DAYS})
      )
      ${projectId ? sql`and p.project_id = ${projectId}` : sql``}
  `;
  const [total] = await sql`
    select count(*)::int as n from wiki_pages
    where active_version_id is not null ${scope(projectId)}
  `;
  return {
    kind: "unused_page",
    considered: Number(total?.n ?? 0),
    findings: rows.map((row) => ({
      subjectType: "wiki_page",
      subjectId: row.id as string,
      projectId: (row.projectId as string | null) ?? null,
      summary: `Page "${row.slug}" has not been selected into a packet in ${UNUSED_PAGE_DAYS} days`,
      detail: { slug: row.slug, pageType: row.pageType, windowDays: UNUSED_PAGE_DAYS },
      recommendedAction:
        "Confirm it is still worth compiling. An unread page costs build time and dilutes retrieval.",
    })),
  };
}

// -------------------------------------------------- wiki/canonical drift

/**
 * Active pages citing claims that are no longer approved.
 *
 * This is the audit that matters most: the compiled layer is allowed to lag
 * canonical truth briefly, but a page serving a rejected or superseded claim
 * is the exact failure the whole architecture exists to prevent.
 */
export async function auditWikiCanonicalConsistency(
  projectId: string | null
): Promise<DetectorResult> {
  const rows = await sql`
    select p.id, p.project_id, p.slug,
      array_agg(distinct c.key) as stale_keys,
      array_agg(distinct c.status) as statuses
    from wiki_pages p
    join wiki_sections s on s.page_id = p.id
    join wiki_section_provenance sp on sp.section_id = s.id
    join claims c on c.id = sp.claim_id
    where p.active_version_id is not null
      and c.status <> 'approved'
      ${projectId ? sql`and p.project_id = ${projectId}` : sql``}
    group by p.id, p.project_id, p.slug
  `;
  const [total] = await sql`
    select count(*)::int as n from wiki_pages
    where active_version_id is not null ${scope(projectId)}
  `;
  return {
    kind: "wiki_canonical_drift",
    considered: Number(total?.n ?? 0),
    findings: rows.map((row) => ({
      subjectType: "wiki_page",
      subjectId: row.id as string,
      projectId: (row.projectId as string | null) ?? null,
      summary: `Page "${row.slug}" serves ${(row.staleKeys as string[]).length} claim(s) that are no longer approved`,
      detail: { slug: row.slug, claimKeys: row.staleKeys, statuses: row.statuses },
      recommendedAction:
        "Rebuild immediately. A compiled page must never outlive the approval of the claims it states.",
    })),
  };
}

// ------------------------------------------------------ stale instructions

/** Instructions whose active version has passed its effective window. */
export async function reviewStaleInstructions(
  projectId: string | null
): Promise<DetectorResult> {
  const rows = await sql`
    select i.id, i.project_id, i.title, i.instruction_type, v.effective_to
    from knowledge_instructions i
    join knowledge_instruction_versions v on v.id = i.active_version_id
    where i.status = 'active'
      and v.effective_to is not null and v.effective_to < current_date
      ${projectId ? sql`and i.project_id = ${projectId}` : sql``}
  `;
  const [total] = await sql`
    select count(*)::int as n from knowledge_instructions
    where status = 'active' ${scope(projectId)}
  `;
  return {
    kind: "stale_instruction",
    considered: Number(total?.n ?? 0),
    findings: rows.map((row) => ({
      subjectType: "knowledge_instruction",
      subjectId: row.id as string,
      projectId: (row.projectId as string | null) ?? null,
      summary: `Instruction "${row.title}" expired on ${row.effectiveTo} but is still active`,
      detail: { title: row.title, type: row.instructionType, effectiveTo: row.effectiveTo },
      recommendedAction:
        "Extend, replace or retire it. Expired instructions still shape every packet that includes them.",
    })),
  };
}

// ------------------------------------------------- privacy compliance sweep

/**
 * Packets that included an item above the audience's privacy ceiling.
 *
 * The builder filters at retrieval time, so this should find nothing. That is
 * exactly why it runs: a sweep that only matters when the primary control has
 * already failed is the one worth having.
 */
export async function sweepPrivacyCompliance(
  projectId: string | null
): Promise<DetectorResult> {
  const rows = await sql`
    select i.id, i.packet_id, ep.project_id, i.item_type, i.item_ref,
      i.privacy_status, ep.purpose
    from context_packet_items i
    join evidence_packets ep on ep.id = i.packet_id
    where i.included
      and i.privacy_status = 'restricted'
      ${projectId ? sql`and ep.project_id = ${projectId}` : sql``}
  `;
  const [total] = await sql`
    select count(*)::int as n from context_packet_items i
    join evidence_packets ep on ep.id = i.packet_id
    where i.included ${projectId ? sql`and ep.project_id = ${projectId}` : sql``}
  `;
  return {
    kind: "privacy_violation",
    considered: Number(total?.n ?? 0),
    findings: rows.map((row) => ({
      subjectType: "context_packet",
      subjectId: row.packetId as string,
      projectId: (row.projectId as string | null) ?? null,
      summary: `Packet included a restricted ${row.itemType} ("${row.itemRef}")`,
      detail: { itemType: row.itemType, itemRef: row.itemRef, purpose: row.purpose },
      recommendedAction:
        "Investigate the builder immediately. Restricted material exists so a human knows about it, never so a model can use it.",
    })),
  };
}

// ------------------------------------------------------- usefulness signals

export interface UsefulnessReport {
  hotFileSelectionRate: number | null;
  packetsBuilt: number;
  packetsWithHotFile: number;
  humanOverrideRate: number | null;
  packetsOverridden: number;
  /** Null when nothing has been built — "not measured", never zero. */
  measured: boolean;
}

/**
 * Hot-file selection rate and human-override rate.
 *
 * Both are `null` rather than `0` when there is no data. A zero override rate
 * on zero packets reads as "operators never disagree", which is a claim we
 * have not earned.
 */
export async function measureUsefulness(
  projectId: string | null
): Promise<UsefulnessReport> {
  const [row] = await sql`
    select
      count(distinct ep.id)::int as packets,
      count(distinct ep.id) filter (
        where exists (
          select 1 from context_packet_items i
          where i.packet_id = ep.id and i.item_type = 'hot_file' and i.included
        )
      )::int as with_hot_file,
      count(distinct ep.id) filter (
        where exists (
          select 1 from context_packet_items i
          where i.packet_id = ep.id and i.exclusion_reason like '%operator%'
        )
      )::int as overridden
    from evidence_packets ep
    where ep.built_at > now() - interval '7 days'
      ${projectId ? sql`and ep.project_id = ${projectId}` : sql``}
  `;
  const packets = Number(row?.packets ?? 0);
  return {
    packetsBuilt: packets,
    packetsWithHotFile: Number(row?.withHotFile ?? 0),
    packetsOverridden: Number(row?.overridden ?? 0),
    hotFileSelectionRate: packets === 0 ? null : Number(row?.withHotFile ?? 0) / packets,
    humanOverrideRate: packets === 0 ? null : Number(row?.overridden ?? 0) / packets,
    measured: packets > 0,
  };
}

export const WEEKLY_DETECTORS = [
  reviewDuplicateEntities,
  reviewWeakEvidence,
  reviewOversizedPages,
  reviewUnusedPages,
  auditWikiCanonicalConsistency,
  reviewStaleInstructions,
  sweepPrivacyCompliance,
] as const;

export type { Finding };
