/**
 * The maintenance detectors (spec 025).
 *
 * Each detector is a pure-ish query returning findings. None of them mutates
 * canonical knowledge, and none deletes anything: a detector's job is to
 * notice, and a human's job is to decide. That separation is the reason this
 * file has no `delete` and no `update claims`.
 *
 * Every detector returns `subjectId`s so the caller can auto-resolve the
 * exceptions whose subjects no longer qualify. A finding that cannot be
 * un-found produces a feed that only grows.
 */
import { sql } from "@/db/client";
import { STALE_PAGE_SLA_HOURS } from "@/lib/knowledge/constants";

export interface Finding {
  subjectType: string;
  subjectId: string | null;
  projectId: string | null;
  summary: string;
  detail: Record<string, unknown>;
  recommendedAction: string;
  severity?: "low" | "medium" | "high" | "critical";
}

export interface DetectorResult {
  kind: string;
  findings: Finding[];
  /** How many rows the detector examined — the denominator for "did it reconcile?" */
  considered: number;
}

const scope = (projectId: string | null) =>
  projectId ? sql`and project_id = ${projectId}` : sql``;

// -------------------------------------------------------- 1. ingestion

/** Sources whose extraction failed. They are invisible to every packet. */
export async function detectFailedIngestions(
  projectId: string | null
): Promise<DetectorResult> {
  const rows = await sql`
    select id, project_id, original_filename, original_url, source_type,
      mime_type, extraction_status, processing_status
    from source_artifacts
    where (extraction_status = 'failed' or processing_status = 'failed')
      and superseded_at is null
      ${scope(projectId)}
    order by created_at desc
  `;
  const [total] = await sql`
    select count(*)::int as n from source_artifacts
    where superseded_at is null ${scope(projectId)}
  `;
  return {
    kind: "failed_ingestion",
    considered: Number(total?.n ?? 0),
    findings: rows.map((row) => ({
      subjectType: "source_artifact",
      subjectId: row.id as string,
      projectId: (row.projectId as string | null) ?? null,
      summary: `Extraction failed for ${row.originalFilename ?? row.originalUrl ?? row.sourceType}`,
      detail: {
        mimeType: row.mimeType,
        extractionStatus: row.extractionStatus,
        processingStatus: row.processingStatus,
      },
      // 'unsupported' is a stated limitation, not a fault; 'failed' is a fault.
      recommendedAction:
        "Reprocess the source. If the format is genuinely unsupported, record that rather than leaving it failed.",
    })),
  };
}

// ------------------------------------------------------------ 2. staleness

/**
 * Pages stale longer than their SLA. Being stale is normal — a claim changed
 * and the rebuild has not run yet. Being stale for days is the problem.
 */
export async function detectStalePages(
  projectId: string | null,
  slaHours = STALE_PAGE_SLA_HOURS
): Promise<DetectorResult> {
  const rows = await sql`
    select id, project_id, slug, page_type, stale_reason, stale_since,
      extract(epoch from (now() - stale_since)) / 3600 as hours_stale
    from wiki_pages
    where stale and stale_since < now() - make_interval(hours => ${slaHours})
      ${scope(projectId)}
    order by stale_since asc
  `;
  const [total] = await sql`select count(*)::int as n from wiki_pages where true ${scope(projectId)}`;
  return {
    kind: "stale_page",
    considered: Number(total?.n ?? 0),
    findings: rows.map((row) => {
      const hours = Math.floor(Number(row.hoursStale ?? 0));
      return {
        subjectType: "wiki_page",
        subjectId: row.id as string,
        projectId: (row.projectId as string | null) ?? null,
        summary: `Page "${row.slug}" has been stale for ${hours}h (${row.staleReason})`,
        detail: { slug: row.slug, pageType: row.pageType, hoursStale: hours },
        recommendedAction: "Run a rebuild for this page, or investigate why its build keeps failing.",
        // Stale past a day is no longer routine.
        severity: hours > slaHours * 3 ? ("medium" as const) : undefined,
      };
    }),
  };
}

// -------------------------------------------------------- 3. expired claims

/** Approved claims past their review date. These must not read as current. */
export async function detectExpiredClaims(
  projectId: string | null
): Promise<DetectorResult> {
  const rows = await sql`
    select id, project_id, key, canonical_text, category, review_date,
      (current_date - review_date) as days_overdue
    from claims
    where status = 'approved' and review_date is not null and review_date < current_date
      ${scope(projectId)}
    order by review_date asc
  `;
  const [total] = await sql`
    select count(*)::int as n from claims where status = 'approved' ${scope(projectId)}
  `;
  return {
    kind: "expired_claim",
    considered: Number(total?.n ?? 0),
    findings: rows.map((row) => ({
      subjectType: "claim",
      subjectId: row.id as string,
      projectId: (row.projectId as string | null) ?? null,
      summary: `Claim "${row.key}" passed review ${row.daysOverdue} days ago`,
      detail: {
        key: row.key,
        category: row.category,
        reviewDate: row.reviewDate,
        daysOverdue: Number(row.daysOverdue ?? 0),
      },
      recommendedAction:
        "Re-verify against current evidence and either extend the review date or supersede the claim.",
    })),
  };
}

// ------------------------------------------------- 4. broken evidence links

/** Claims citing evidence rows that no longer exist. */
export async function detectBrokenEvidenceLinks(
  projectId: string | null
): Promise<DetectorResult> {
  const rows = await sql`
    select c.id, c.project_id, c.key, c.evidence_ids,
      array(
        select e_id from unnest(c.evidence_ids) as e_id
        where not exists (select 1 from evidence e where e.id = e_id)
      ) as missing
    from claims c
    where c.status = 'approved' and cardinality(c.evidence_ids) > 0
      ${projectId ? sql`and c.project_id = ${projectId}` : sql``}
  `;
  const broken = rows.filter((row) => (row.missing as string[]).length > 0);
  return {
    kind: "broken_evidence_link",
    considered: rows.length,
    findings: broken.map((row) => ({
      subjectType: "claim",
      subjectId: row.id as string,
      projectId: (row.projectId as string | null) ?? null,
      summary: `Claim "${row.key}" cites ${(row.missing as string[]).length} evidence row(s) that no longer exist`,
      detail: { key: row.key, missingEvidenceIds: row.missing },
      recommendedAction:
        "Restore or replace the evidence. An approved claim without its support must not stay approved.",
    })),
  };
}

// ------------------------------------------------------ 5. orphaned claims

/** Approved claims with no evidence at all. */
export async function detectOrphanedClaims(
  projectId: string | null
): Promise<DetectorResult> {
  const rows = await sql`
    select id, project_id, key, canonical_text from claims
    where status = 'approved' and cardinality(evidence_ids) = 0 ${scope(projectId)}
  `;
  const [total] = await sql`
    select count(*)::int as n from claims where status = 'approved' ${scope(projectId)}
  `;
  return {
    kind: "orphaned_claim",
    considered: Number(total?.n ?? 0),
    findings: rows.map((row) => ({
      subjectType: "claim",
      subjectId: row.id as string,
      projectId: (row.projectId as string | null) ?? null,
      summary: `Approved claim "${row.key}" has no evidence`,
      detail: { key: row.key, text: row.canonicalText },
      recommendedAction:
        "Attach the evidence it was approved on, or withdraw the approval. Unsupported approved claims reach agents.",
    })),
  };
}

// ------------------------------------------------- 6. dependency mismatches

/**
 * Pages whose declared dependencies do not match the claims their sections
 * actually cite.
 *
 * This is the check that keeps incremental rebuilds correct. If a page reads a
 * claim it never declared, that claim changing will not mark the page stale —
 * so the page silently serves outdated facts forever, and no other detector
 * would ever notice.
 */
export async function detectDependencyMismatches(
  projectId: string | null
): Promise<DetectorResult> {
  const rows = await sql`
    select p.id, p.project_id, p.slug,
      array(
        select distinct sp.claim_id::text
        from wiki_sections s
        join wiki_section_provenance sp on sp.section_id = s.id
        where s.page_id = p.id and sp.claim_id is not null
      ) as cited,
      array(
        select distinct d.dependency_id::text
        from wiki_page_dependencies d
        where d.page_id = p.id and d.dependency_type = 'claim'
      ) as declared
    from wiki_pages p
    where p.active_version_id is not null
      ${projectId ? sql`and p.project_id = ${projectId}` : sql``}
  `;
  const findings: Finding[] = [];
  for (const row of rows) {
    const cited = new Set(row.cited as string[]);
    const declared = new Set(row.declared as string[]);
    const undeclared = [...cited].filter((id) => !declared.has(id));
    if (undeclared.length === 0) continue;
    findings.push({
      subjectType: "wiki_page",
      subjectId: row.id as string,
      projectId: (row.projectId as string | null) ?? null,
      summary: `Page "${row.slug}" cites ${undeclared.length} claim(s) it did not declare as dependencies`,
      detail: { slug: row.slug, undeclaredClaimIds: undeclared },
      recommendedAction:
        "Recompile the page. Until then a change to those claims will not mark it stale, so it can serve outdated facts.",
    });
  }
  return { kind: "dependency_mismatch", considered: rows.length, findings };
}

// ---------------------------------------------------- 7. page hash mismatch

/** Stored body no longer hashes to its recorded content hash. */
export async function detectPageHashMismatches(
  projectId: string | null
): Promise<DetectorResult> {
  const rows = await sql`
    select v.id, v.page_id, p.project_id, p.slug, v.version, v.content_hash,
      encode(sha256(convert_to(v.body_markdown, 'UTF8')), 'hex') as actual_hash
    from wiki_page_versions v
    join wiki_pages p on p.id = v.page_id
    where p.active_version_id = v.id
      ${projectId ? sql`and p.project_id = ${projectId}` : sql``}
  `;
  const mismatched = rows.filter((row) => row.contentHash !== row.actualHash);
  return {
    kind: "page_hash_mismatch",
    considered: rows.length,
    findings: mismatched.map((row) => ({
      subjectType: "wiki_page",
      subjectId: row.pageId as string,
      projectId: (row.projectId as string | null) ?? null,
      summary: `Active version of "${row.slug}" does not match its recorded content hash`,
      detail: {
        slug: row.slug,
        version: row.version,
        recordedHash: row.contentHash,
        actualHash: row.actualHash,
      },
      recommendedAction:
        "Treat the page as untrusted and recompile. A body that changed without a new version means something wrote around the compiler.",
    })),
  };
}

// --------------------------------------------------------- 8. failed builds

export async function detectFailedBuilds(
  projectId: string | null
): Promise<DetectorResult> {
  const rows = await sql`
    select id, project_id, status, failed, requested_pages, error, started_at
    from knowledge_builds
    where status in ('failed', 'partial')
      and started_at > now() - interval '7 days'
      ${scope(projectId)}
    order by started_at desc
  `;
  const [total] = await sql`
    select count(*)::int as n from knowledge_builds
    where started_at > now() - interval '7 days' ${scope(projectId)}
  `;
  return {
    kind: "failed_build",
    considered: Number(total?.n ?? 0),
    findings: rows.map((row) => ({
      subjectType: "knowledge_build",
      subjectId: row.id as string,
      projectId: (row.projectId as string | null) ?? null,
      summary: `Build ${row.status}: ${row.failed} of ${row.requestedPages} page(s) failed`,
      detail: { status: row.status, failed: row.failed, error: row.error },
      recommendedAction: "Inspect the build items and retry. Repeated failures mean a template or data problem.",
    })),
  };
}

// -------------------------------------------------- 9. retention & holds

/** Sources past their retention window. Never auto-deleted — surfaced. */
export async function detectRetentionDue(
  projectId: string | null
): Promise<DetectorResult> {
  const rows = await sql`
    select id, project_id, original_filename, retention_class, retention_due_at, legal_hold
    from source_artifacts
    where retention_due_at is not null and retention_due_at < now()
      and purged_at is null
      ${scope(projectId)}
    order by retention_due_at asc
  `;
  const [total] = await sql`
    select count(*)::int as n from source_artifacts
    where purged_at is null ${scope(projectId)}
  `;
  return {
    kind: "retention_due",
    considered: Number(total?.n ?? 0),
    findings: rows.map((row) => ({
      subjectType: "source_artifact",
      subjectId: row.id as string,
      projectId: (row.projectId as string | null) ?? null,
      summary: row.legalHold
        ? `Retention due for "${row.originalFilename}" but it is under legal hold`
        : `Retention window elapsed for "${row.originalFilename}"`,
      detail: {
        retentionClass: row.retentionClass,
        dueAt: row.retentionDueAt,
        legalHold: row.legalHold,
      },
      // A hold outliving its retention date is a legal decision, not a chore.
      recommendedAction: row.legalHold
        ? "Under legal hold: purging is blocked by the database. Clear the hold only with a recorded reason."
        : "Review and purge if no longer needed. Deletion is never automatic.",
    })),
  };
}

/** Every daily detector, in the order the spec lists them. */
export const DAILY_DETECTORS = [
  detectFailedIngestions,
  detectStalePages,
  detectExpiredClaims,
  detectBrokenEvidenceLinks,
  detectOrphanedClaims,
  detectDependencyMismatches,
  detectPageHashMismatches,
  detectFailedBuilds,
  detectRetentionDue,
] as const;
