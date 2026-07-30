/**
 * Read queries for the knowledge-layer UI (docs/11: data access lives in db/,
 * never inside a React component).
 *
 * Every function is client-scoped. There is no "read across clients" query in
 * this file, deliberately — the UI cannot render a cross-client view because
 * there is nothing here that would return one.
 */
import { sql } from "@/db/client";

export interface SourceRow {
  id: string;
  sourceType: string;
  origin: string;
  label: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  privacy: string;
  retention: string;
  version: number;
  supersededAt: string | null;
  extractionStatus: string;
  processingStatus: string;
  retrievedAt: string;
  effectiveDate: string | null;
  extractorKey: string | null;
  extractorVersion: string | null;
  textLength: number;
  claimCount: number;
}

export async function listSources(projectId: string): Promise<SourceRow[]> {
  const rows = await sql`
    select a.id, a.source_type, a.origin,
      coalesce(a.original_filename, a.original_url, a.source_type) as label,
      a.mime_type, a.byte_size, a.sha256, a.privacy_classification, a.retention_class,
      a.version, a.superseded_at, a.extraction_status, a.processing_status,
      a.retrieved_at, to_char(a.effective_date, 'YYYY-MM-DD') as effective_date,
      d.extractor_key, d.extractor_version, coalesce(length(d.text), 0) as text_length,
      (select count(*)::int from claims c where a.id = any(c.source_artifact_ids)) as claim_count
    from source_artifacts a
    left join lateral (
      select extractor_key, extractor_version, text from extracted_documents
      where source_artifact_id = a.id order by created_at desc limit 1
    ) d on true
    where a.project_id = ${projectId}
    order by a.retrieved_at desc
  `;
  return rows.map((row) => ({
    id: row.id as string,
    sourceType: row.sourceType as string,
    origin: row.origin as string,
    label: row.label as string,
    mimeType: row.mimeType as string,
    byteSize: Number(row.byteSize),
    sha256: row.sha256 as string,
    privacy: row.privacyClassification as string,
    retention: row.retentionClass as string,
    version: row.version as number,
    supersededAt: row.supersededAt ? String(row.supersededAt) : null,
    extractionStatus: row.extractionStatus as string,
    processingStatus: row.processingStatus as string,
    retrievedAt: String(row.retrievedAt),
    effectiveDate: (row.effectiveDate as string | null) ?? null,
    extractorKey: (row.extractorKey as string | null) ?? null,
    extractorVersion: (row.extractorVersion as string | null) ?? null,
    textLength: Number(row.textLength),
    claimCount: Number(row.claimCount),
  }));
}

export interface WikiPageRow {
  id: string;
  slug: string;
  pageType: string;
  title: string;
  tokenBudget: number | null;
  tokenCount: number;
  version: number | null;
  versionId: string | null;
  freshness: string;
  privacy: string;
  stale: boolean;
  staleReason: string;
  generatedAt: string | null;
  compilerVersion: string | null;
  dependencyCount: number;
}

export async function listWikiPages(projectId: string): Promise<WikiPageRow[]> {
  const rows = await sql`
    select p.id, p.slug, p.page_type, p.title, p.token_budget, p.freshness_status,
      p.privacy_classification, p.stale, p.stale_reason,
      v.id as version_id, v.version, v.token_count, v.generated_at, v.compiler_version,
      (select count(*)::int from wiki_page_dependencies d where d.page_id = p.id) as dependency_count
    from wiki_pages p
    left join wiki_page_versions v on v.id = p.active_version_id
    where p.project_id = ${projectId}
    order by case p.page_type when 'hot_file' then 0 else 1 end, p.slug asc
  `;
  return rows.map((row) => ({
    id: row.id as string,
    slug: row.slug as string,
    pageType: row.pageType as string,
    title: row.title as string,
    tokenBudget: (row.tokenBudget as number | null) ?? null,
    tokenCount: Number(row.tokenCount ?? 0),
    version: (row.version as number | null) ?? null,
    versionId: (row.versionId as string | null) ?? null,
    freshness: row.freshnessStatus as string,
    privacy: row.privacyClassification as string,
    stale: Boolean(row.stale),
    staleReason: (row.staleReason as string) ?? "",
    generatedAt: row.generatedAt ? String(row.generatedAt) : null,
    compilerVersion: (row.compilerVersion as string | null) ?? null,
    dependencyCount: Number(row.dependencyCount),
  }));
}

export async function pageVersionHistory(
  pageId: string
): Promise<{ id: string; version: number; tokenCount: number; contentHash: string; generatedAt: string; templateVersion: string }[]> {
  const rows = await sql`
    select id, version, token_count, content_hash, generated_at, template_version
    from wiki_page_versions where page_id = ${pageId}
    order by version desc limit 25
  `;
  return rows.map((row) => ({
    id: row.id as string,
    version: row.version as number,
    tokenCount: row.tokenCount as number,
    contentHash: row.contentHash as string,
    generatedAt: String(row.generatedAt),
    templateVersion: row.templateVersion as string,
  }));
}

export interface BuildRow {
  id: string;
  trigger: string;
  triggerRef: string | null;
  status: string;
  requested: number;
  compiled: number;
  noOp: number;
  failed: number;
  durationMs: number;
  startedAt: string;
  error: string | null;
}

export async function listBuilds(projectId: string, limit = 25): Promise<BuildRow[]> {
  const rows = await sql`
    select id, trigger, trigger_ref, status, requested_pages, compiled, no_op,
      failed, duration_ms, started_at, error
    from knowledge_builds where project_id = ${projectId}
    order by started_at desc limit ${limit}
  `;
  return rows.map((row) => ({
    id: row.id as string,
    trigger: row.trigger as string,
    triggerRef: (row.triggerRef as string | null) ?? null,
    status: row.status as string,
    requested: row.requestedPages as number,
    compiled: row.compiled as number,
    noOp: row.noOp as number,
    failed: row.failed as number,
    durationMs: row.durationMs as number,
    startedAt: String(row.startedAt),
    error: (row.error as string | null) ?? null,
  }));
}

export async function buildItems(buildId: string): Promise<
  { slug: string; status: string; reason: string; tokenCount: number; error: string | null }[]
> {
  const rows = await sql`
    select p.slug, i.status, i.reason, i.token_count, i.error
    from knowledge_build_items i
    join wiki_pages p on p.id = i.page_id
    where i.build_id = ${buildId}
    order by i.status asc, p.slug asc
  `;
  return rows.map((row) => ({
    slug: row.slug as string,
    status: row.status as string,
    reason: (row.reason as string) ?? "",
    tokenCount: row.tokenCount as number,
    error: (row.error as string | null) ?? null,
  }));
}

export interface PacketRow {
  id: string;
  templateKey: string | null;
  agentKey: string | null;
  objective: string;
  audience: string;
  tokenCount: number;
  tokenBudget: number | null;
  claimCount: number;
  withheldCount: number;
  builtAt: string;
  contentHash: string;
  missingCount: number;
}

export async function listPackets(projectId: string, limit = 25): Promise<PacketRow[]> {
  const rows = await sql`
    select id, template_key, agent_key, task_objective, audience, token_count,
      token_budget, claim_ids, withheld_claim_ids, built_at, content_hash,
      missing_context
    from evidence_packets where project_id = ${projectId}
    order by built_at desc limit ${limit}
  `;
  return rows.map((row) => ({
    id: row.id as string,
    templateKey: (row.templateKey as string | null) ?? null,
    agentKey: (row.agentKey as string | null) ?? null,
    objective: (row.taskObjective as string) ?? "",
    audience: (row.audience as string) ?? "internal",
    tokenCount: Number(row.tokenCount ?? 0),
    tokenBudget: (row.tokenBudget as number | null) ?? null,
    claimCount: ((row.claimIds as string[]) ?? []).length,
    withheldCount: ((row.withheldClaimIds as string[]) ?? []).length,
    builtAt: String(row.builtAt),
    contentHash: row.contentHash as string,
    missingCount: ((row.missingContext as unknown[]) ?? []).length,
  }));
}

export interface ContradictionRow {
  id: string;
  claimId: string;
  claimText: string;
  contradictingClaimId: string | null;
  contradictingText: string | null;
  severity: string;
  description: string;
  detectedBy: string;
  status: string;
}

export async function listContradictions(projectId: string): Promise<ContradictionRow[]> {
  const rows = await sql`
    select k.id, k.claim_id, a.canonical_text as claim_text,
      k.contradicting_claim_id, b.canonical_text as contradicting_text,
      k.severity, k.description, k.detected_by, k.status
    from claim_contradictions k
    join claims a on a.id = k.claim_id
    left join claims b on b.id = k.contradicting_claim_id
    where k.project_id = ${projectId} and k.status = 'open'
    order by case k.severity when 'critical' then 0 when 'high' then 1
      when 'medium' then 2 else 3 end
  `;
  return rows.map((row) => ({
    id: row.id as string,
    claimId: row.claimId as string,
    claimText: row.claimText as string,
    contradictingClaimId: (row.contradictingClaimId as string | null) ?? null,
    contradictingText: (row.contradictingText as string | null) ?? null,
    severity: row.severity as string,
    description: row.description as string,
    detectedBy: (row.detectedBy as string) ?? "deterministic",
    status: row.status as string,
  }));
}

export async function knowledgeSummary(projectId: string): Promise<{
  sources: number;
  unreadableSources: number;
  approvedClaims: number;
  proposedClaims: number;
  openContradictions: number;
  instructions: number;
  pages: number;
  stalePages: number;
  packets: number;
}> {
  const [row] = await sql`
    select
      (select count(*)::int from source_artifacts where project_id = ${projectId}) as sources,
      (select count(*)::int from source_artifacts where project_id = ${projectId}
        and extraction_status in ('failed', 'unsupported')) as unreadable_sources,
      (select count(*)::int from claims where project_id = ${projectId} and status = 'approved') as approved_claims,
      (select count(*)::int from claims where project_id = ${projectId} and status = 'proposed') as proposed_claims,
      (select count(*)::int from claim_contradictions where project_id = ${projectId} and status = 'open') as open_contradictions,
      (select count(*)::int from knowledge_instructions where project_id = ${projectId} and status = 'active') as instructions,
      (select count(*)::int from wiki_pages where project_id = ${projectId}) as pages,
      (select count(*)::int from wiki_pages where project_id = ${projectId} and stale) as stale_pages,
      (select count(*)::int from evidence_packets where project_id = ${projectId}) as packets
  `;
  return {
    sources: Number(row!.sources),
    unreadableSources: Number(row!.unreadableSources),
    approvedClaims: Number(row!.approvedClaims),
    proposedClaims: Number(row!.proposedClaims),
    openContradictions: Number(row!.openContradictions),
    instructions: Number(row!.instructions),
    pages: Number(row!.pages),
    stalePages: Number(row!.stalePages),
    packets: Number(row!.packets),
  };
}
