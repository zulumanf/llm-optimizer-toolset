/**
 * Load everything the page templates may read, once per build (spec 023).
 *
 * Loading once per build rather than once per page is the difference between a
 * nine-page client build issuing nine sets of the same queries and issuing one.
 * It also guarantees every page in a build sees the same snapshot, so two pages
 * compiled in the same build cannot disagree.
 *
 * Only `approved` claims reach a compiled page. A proposed claim is not
 * something the platform is allowed to believe, and a compiled page is what an
 * agent reads.
 */
import { sql } from "@/db/client";
import { RECENT_CHANGES_WINDOW_DAYS } from "@/lib/knowledge/constants";
import { assessFreshness } from "@/lib/knowledge/freshness";
import { resolveInstructions } from "@/lib/knowledge/instructions/service";
import type {
  ClientKnowledge,
  CompileContext,
  CompiledClaim,
} from "@/lib/knowledge/compiler/types";

export async function loadCompileContext(args: {
  projectId: string | null;
  now?: Date;
}): Promise<CompileContext> {
  const now = args.now ?? new Date();
  const projectId = args.projectId;

  let projectName = "Shared knowledge";
  if (projectId) {
    const [project] = await sql`select name from projects where id = ${projectId}`;
    if (!project) {
      throw new Error(`Cannot compile: client ${projectId} does not exist.`);
    }
    projectName = project.name as string;
  }

  const data = projectId
    ? await loadClientKnowledge(projectId, now)
    : emptyKnowledge();

  return { projectId, projectName, now, data };
}

async function loadClientKnowledge(projectId: string, now: Date): Promise<ClientKnowledge> {
  const [
    claimRows,
    contradictionRows,
    entityRows,
    competitorRows,
    actionRows,
    metricRows,
    sourceRows,
  ] = await Promise.all([
    sql`
      select c.id, c.key, c.canonical_text, c.value, c.category, c.materiality,
        c.status, c.privacy_status, c.verification_status, c.confidence,
        to_char(c.as_of, 'YYYY-MM-DD') as as_of,
        to_char(c.effective_date, 'YYYY-MM-DD') as effective_date,
        to_char(c.review_date, 'YYYY-MM-DD') as review_date,
        c.last_verified_at, c.allowed_wording, c.prohibited_wording,
        c.evidence_ids, c.source_artifact_ids, c.subject_entity,
        c.subject_entity_id, c.normalized_predicate,
        (select v.id from claim_versions v where v.claim_id = c.id
          order by v.version desc limit 1) as claim_version_id
      from claims c
      where c.project_id = ${projectId} and c.status = 'approved'
      order by c.category asc, c.key asc
    `,
    sql`
      select id, claim_id, contradicting_claim_id, severity, description, detected_by
      from claim_contradictions
      where project_id = ${projectId} and status = 'open'
      order by case severity when 'critical' then 0 when 'high' then 1
        when 'medium' then 2 else 3 end
    `,
    sql`
      select e.id, e.entity_type, e.canonical_name, e.slug, e.description, e.company_id,
        coalesce(array_agg(a.alias) filter (where a.alias is not null), '{}') as aliases
      from knowledge_entities e
      left join entity_aliases a on a.entity_id = e.id
      where (e.project_id = ${projectId} or e.project_id is null) and e.status = 'active'
      group by e.id
      order by e.entity_type asc, e.canonical_name asc
    `,
    sql`
      select co.id, co.name, co.domain, cp.tier
      from competitors cp join companies co on co.id = cp.company_id
      where cp.project_id = ${projectId} and cp.archived_at is null
      order by cp.tier asc, co.name asc
    `,
    sql`
      select id, title, status, asset_type, created_at
      from content_assets
      where project_id = ${projectId} and status <> 'published'
      order by created_at desc limit 25
    `,
    sql`
      select s.metric, s.value, s.sample_size, s.scoring_version, s.computed_at
      from scores s
      join runs r on r.id = s.run_id
      join companies c on c.id = s.company_id
      join projects p on p.id = r.project_id
      where r.project_id = ${projectId} and c.id = p.subject_company_id
      order by s.computed_at desc limit 20
    `,
    sql`
      select id, source_type, coalesce(original_filename, original_url, source_type) as label,
        privacy_classification, retrieved_at, extraction_status
      from source_artifacts
      where project_id = ${projectId} and superseded_at is null
      order by retrieved_at desc limit 50
    `,
  ]);

  const claims: CompiledClaim[] = claimRows.map((row) => {
    const freshness = assessFreshness(
      {
        category: (row.category as string) ?? "general",
        status: row.status as string,
        asOf: (row.asOf as string | null) ?? null,
        effectiveDate: (row.effectiveDate as string | null) ?? null,
        reviewDate: (row.reviewDate as string | null) ?? null,
        lastVerifiedAt: (row.lastVerifiedAt as Date | null) ?? null,
        verificationStatus: (row.verificationStatus as string | null) ?? null,
      },
      now
    );
    return {
      id: row.id as string,
      key: row.key as string,
      canonicalText: row.canonicalText as string,
      value: row.value ?? null,
      category: (row.category as string) ?? "general",
      materiality: (row.materiality as string) ?? "ordinary",
      status: row.status as string,
      privacyStatus: (row.privacyStatus as string) ?? "public",
      verificationStatus: (row.verificationStatus as string) ?? "unverified",
      confidence: row.confidence === null ? null : Number(row.confidence),
      asOf: (row.asOf as string | null) ?? null,
      effectiveDate: (row.effectiveDate as string | null) ?? null,
      reviewDate: (row.reviewDate as string | null) ?? null,
      lastVerifiedAt: row.lastVerifiedAt ? String(row.lastVerifiedAt) : null,
      allowedWording: (row.allowedWording as string[]) ?? [],
      prohibitedWording: (row.prohibitedWording as string[]) ?? [],
      evidenceIds: (row.evidenceIds as string[]) ?? [],
      sourceArtifactIds: (row.sourceArtifactIds as string[]) ?? [],
      subjectEntity: (row.subjectEntity as string | null) ?? null,
      subjectEntityId: (row.subjectEntityId as string | null) ?? null,
      normalizedPredicate: (row.normalizedPredicate as string | null) ?? null,
      claimVersionId: (row.claimVersionId as string | null) ?? null,
      freshness: freshness.state,
      freshnessReason: freshness.reason,
    };
  });

  const { instructions } = await resolveInstructions({ projectId, at: now });

  return {
    claims,
    contradictions: contradictionRows.map((row) => ({
      id: row.id as string,
      claimId: row.claimId as string,
      contradictingClaimId: (row.contradictingClaimId as string | null) ?? null,
      severity: row.severity as string,
      description: row.description as string,
      detectedBy: (row.detectedBy as string) ?? "deterministic",
    })),
    entities: entityRows.map((row) => ({
      id: row.id as string,
      entityType: row.entityType as string,
      canonicalName: row.canonicalName as string,
      slug: row.slug as string,
      description: (row.description as string) ?? "",
      companyId: (row.companyId as string | null) ?? null,
      aliases: ((row.aliases as string[]) ?? []).filter(Boolean),
    })),
    competitors: competitorRows.map((row) => ({
      id: row.id as string,
      name: row.name as string,
      domain: (row.domain as string | null) ?? null,
      note: `${row.tier as string} competitor`,
    })),
    actions: actionRows.map((row) => ({
      id: row.id as string,
      title: row.title as string,
      status: row.status as string,
      kind: row.assetType as string,
      createdAt: isoOf(row.createdAt),
    })),
    metrics: metricRows.map((row) => ({
      metric: row.metric as string,
      value: Number(row.value),
      sampleSize: Number(row.sampleSize),
      scoringVersion: row.scoringVersion as string,
      computedAt: isoOf(row.computedAt),
    })),
    sources: sourceRows.map((row) => ({
      id: row.id as string,
      sourceType: row.sourceType as string,
      label: row.label as string,
      privacy: row.privacyClassification as string,
      retrievedAt: isoOf(row.retrievedAt),
      extractionStatus: row.extractionStatus as string,
    })),
    instructions: instructions.map((i) => ({
      id: i.id,
      versionId: i.versionId,
      instructionType: i.instructionType,
      title: i.title,
      body: i.body,
      isSafety: i.isSafety,
    })),
    recentChanges: await loadRecentChanges(projectId, now),
  };
}

/**
 * Canonical changes inside the window. Read from the audit log rather than a
 * bespoke changelog table: the audit log already records every approval,
 * ingestion and revision, and a second changelog would be a second truth.
 */
async function loadRecentChanges(
  projectId: string,
  now: Date
): Promise<{ kind: string; subject: string; at: string }[]> {
  const since = new Date(now.getTime() - RECENT_CHANGES_WINDOW_DAYS * 86_400_000);
  const rows = await sql`
    select a.action, a.entity, a.entity_id, a.at, a.detail
    from audit_log a
    where a.at >= ${since}
      and a.action in (
        'claim.approve', 'claim.propose', 'knowledge.source.ingest',
        'knowledge.instruction.revise', 'knowledge.entity.merge'
      )
      and (
        a.entity_id in (select id from claims where project_id = ${projectId})
        or a.entity_id in (select id from source_artifacts where project_id = ${projectId})
      )
    order by a.at desc
    limit 40
  `;
  return rows.map((row) => ({
    kind: row.action as string,
    subject: describeChange(row.detail),
    at: isoOf(row.at),
  }));
}

function describeChange(detail: unknown): string {
  if (detail && typeof detail === "object") {
    const record = detail as Record<string, unknown>;
    for (const field of ["key", "sourceType", "reason", "version"]) {
      if (record[field]) return String(record[field]);
    }
  }
  return "(no detail recorded)";
}

function emptyKnowledge(): ClientKnowledge {
  return {
    claims: [],
    contradictions: [],
    entities: [],
    competitors: [],
    actions: [],
    metrics: [],
    sources: [],
    instructions: [],
    recentChanges: [],
  };
}

function isoOf(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value ?? "");
}
