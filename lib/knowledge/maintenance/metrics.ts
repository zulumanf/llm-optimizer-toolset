/**
 * Knowledge quality metrics (spec 025).
 *
 * Every rate here returns `null` when its denominator is zero, never `0`. A
 * zero extraction-failure rate over zero sources reads as "extraction is
 * perfect"; a null reads as "not measured". The platform already refuses to
 * report human-time-saved for the same reason (DECISIONS, 2026-07-29), and the
 * same rule applies to its own health.
 *
 * Agent-quality metrics are deliberately absent. They need a live provider run
 * to mean anything, and inventing them from mock traffic would be exactly the
 * fabricated measurement PRINCIPLES #5 forbids. `lib/knowledge/context/
 * experiment.ts` measures tokens honestly and labels quality unmeasured; that
 * stays true until spec 025's live harness is actually run.
 */
import { sql } from "@/db/client";

/** A rate that knows the difference between zero and unknown. */
function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

export interface IngestionMetrics {
  sources: number;
  duplicateRate: number | null;
  extractionFailureRate: number | null;
  reprocessingRate: number | null;
  /** Median minutes from upload to a proposed claim. Null when none completed. */
  medianMinutesToCanonical: number | null;
}

export async function ingestionMetrics(projectId: string | null): Promise<IngestionMetrics> {
  const [row] = await sql`
    select
      count(*)::int as total,
      count(*) filter (where superseded_at is not null)::int as superseded,
      count(*) filter (where extraction_status = 'failed')::int as failed,
      count(*) filter (where version > 1)::int as reprocessed,
      percentile_cont(0.5) within group (
        order by extract(epoch from (updated_ts - created_at)) / 60
      ) filter (where processing_status = 'complete') as median_minutes
    from (
      select s.*, greatest(s.created_at, coalesce(
        (select max(c.created_at) from claims c where c.project_id = s.project_id), s.created_at
      )) as updated_ts
      from source_artifacts s
      where true ${projectId ? sql`and s.project_id = ${projectId}` : sql``}
    ) t
  `;
  const total = Number(row?.total ?? 0);
  return {
    sources: total,
    duplicateRate: rate(Number(row?.superseded ?? 0), total),
    extractionFailureRate: rate(Number(row?.failed ?? 0), total),
    reprocessingRate: rate(Number(row?.reprocessed ?? 0), total),
    medianMinutesToCanonical:
      row?.medianMinutes === null || row?.medianMinutes === undefined
        ? null
        : Number(row.medianMinutes),
  };
}

export interface CanonicalMetrics {
  approved: number;
  proposed: number;
  expired: number;
  contradictionRate: number | null;
  evidenceCoverage: number | null;
  humanCorrectionRate: number | null;
}

export async function canonicalMetrics(projectId: string | null): Promise<CanonicalMetrics> {
  const scope = projectId ? sql`and project_id = ${projectId}` : sql``;
  const [row] = await sql`
    select
      count(*) filter (where status = 'approved')::int as approved,
      count(*) filter (where status = 'proposed')::int as proposed,
      count(*) filter (where status = 'rejected')::int as rejected,
      count(*) filter (where status = 'approved' and review_date < current_date)::int as expired,
      count(*) filter (where status = 'approved' and cardinality(evidence_ids) > 0)::int as with_evidence
    from claims where true ${scope}
  `;
  const [contra] = await sql`
    select count(*)::int as n from claim_contradictions
    where status = 'open' ${scope}
  `;
  const approved = Number(row?.approved ?? 0);
  const decided = approved + Number(row?.rejected ?? 0);
  return {
    approved,
    proposed: Number(row?.proposed ?? 0),
    expired: Number(row?.expired ?? 0),
    contradictionRate: rate(Number(contra?.n ?? 0), approved),
    evidenceCoverage: rate(Number(row?.withEvidence ?? 0), approved),
    // Rejections are the human correcting what extraction proposed.
    humanCorrectionRate: rate(Number(row?.rejected ?? 0), decided),
  };
}

export interface CompilationMetrics {
  builds: number;
  pagesCompiled: number;
  noOpRate: number | null;
  failureRate: number | null;
  /** Share of builds that touched a subset rather than everything. */
  incrementalRate: number | null;
  medianDurationMs: number | null;
}

export async function compilationMetrics(projectId: string | null): Promise<CompilationMetrics> {
  const [row] = await sql`
    select
      count(*)::int as builds,
      coalesce(sum(compiled), 0)::int as compiled,
      coalesce(sum(no_op), 0)::int as no_op,
      coalesce(sum(failed), 0)::int as failed,
      coalesce(sum(requested_pages), 0)::int as requested,
      count(*) filter (where trigger <> 'initial')::int as incremental,
      percentile_cont(0.5) within group (order by duration_ms) as median_ms
    from knowledge_builds
    where true ${projectId ? sql`and project_id = ${projectId}` : sql``}
  `;
  const requested = Number(row?.requested ?? 0);
  const builds = Number(row?.builds ?? 0);
  return {
    builds,
    pagesCompiled: Number(row?.compiled ?? 0),
    noOpRate: rate(Number(row?.noOp ?? 0), requested),
    failureRate: rate(Number(row?.failed ?? 0), requested),
    incrementalRate: rate(Number(row?.incremental ?? 0), builds),
    medianDurationMs:
      row?.medianMs === null || row?.medianMs === undefined ? null : Number(row.medianMs),
  };
}

export interface RetrievalMetrics {
  packets: number;
  medianTokens: number | null;
  staleInclusionRate: number | null;
  missingRequiredRate: number | null;
  /** Cross-client leakage. Must be exactly 0; null only when no packets exist. */
  crossClientLeakageRate: number | null;
}

export async function retrievalMetrics(projectId: string | null): Promise<RetrievalMetrics> {
  const scope = projectId ? sql`and ep.project_id = ${projectId}` : sql``;
  const [row] = await sql`
    select
      count(distinct ep.id)::int as packets,
      percentile_cont(0.5) within group (
        order by (select coalesce(sum(i.token_cost), 0)
                  from context_packet_items i where i.packet_id = ep.id and i.included)
      ) as median_tokens,
      count(distinct ep.id) filter (
        where exists (
          select 1 from context_packet_items i
          where i.packet_id = ep.id and i.included
            and i.freshness_status in ('stale', 'expired')
        )
      )::int as with_stale,
      count(distinct ep.id) filter (
        where cardinality(ep.withheld_claim_ids) > 0
      )::int as with_withheld
    from evidence_packets ep
    where true ${scope}
  `;

  // Leakage: any packet item referencing a claim belonging to another client.
  const [leak] = await sql`
    select count(distinct ep.id)::int as n
    from evidence_packets ep
    join context_packet_items i on i.packet_id = ep.id
    join claims c on c.id::text = i.item_ref
    where i.item_type = 'claim' and i.included
      and c.project_id is distinct from ep.project_id
      ${scope}
  `;

  const packets = Number(row?.packets ?? 0);
  return {
    packets,
    medianTokens:
      row?.medianTokens === null || row?.medianTokens === undefined
        ? null
        : Number(row.medianTokens),
    staleInclusionRate: rate(Number(row?.withStale ?? 0), packets),
    missingRequiredRate: rate(Number(row?.withWithheld ?? 0), packets),
    crossClientLeakageRate: rate(Number(leak?.n ?? 0), packets),
  };
}

export interface KnowledgeHealth {
  ingestion: IngestionMetrics;
  canonical: CanonicalMetrics;
  compilation: CompilationMetrics;
  retrieval: RetrievalMetrics;
  openExceptions: number;
  /**
   * Agent quality is not measured here and says so. It requires a live
   * provider run (spec 025's opt-in harness); deriving it from mock traffic
   * would be a fabricated measurement.
   */
  agentQualityMeasured: false;
}

export async function knowledgeHealth(projectId: string | null): Promise<KnowledgeHealth> {
  const [ingestion, canonical, compilation, retrieval, exceptions] = await Promise.all([
    ingestionMetrics(projectId),
    canonicalMetrics(projectId),
    compilationMetrics(projectId),
    retrievalMetrics(projectId),
    sql`select count(*)::int as n from knowledge_exceptions where status = 'open'
        ${projectId ? sql`and project_id = ${projectId}` : sql``}`,
  ]);
  return {
    ingestion,
    canonical,
    compilation,
    retrieval,
    openExceptions: Number(exceptions[0]?.n ?? 0),
    agentQualityMeasured: false,
  };
}
