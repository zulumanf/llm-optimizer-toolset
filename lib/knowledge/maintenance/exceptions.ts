/**
 * Knowledge exceptions (spec 025).
 *
 * Deliberately mirrors `lib/workflow/exceptions.ts` rather than inventing a
 * second vocabulary: the Today feed already knows how to read that shape, so
 * a maintenance finding lands where the operator already looks.
 *
 * The one behaviour worth stating: `raiseKnowledgeException` is an **upsert on
 * (kind, subject)**, not an insert. A daily job that re-reports the same stale
 * page every morning produces a feed nobody reads, and an ignored feed is
 * worse than no feed — it converts a working detector into decoration. So a
 * repeat finding refreshes the existing open exception and bumps a counter
 * recording how many days it has persisted, which is the signal that actually
 * matters: not "this page is stale" but "this page has been stale for nine
 * days and nobody has acted".
 */
import { sql, type TransactionSql } from "@/db/client";

type Tx = TransactionSql | typeof sql;

export const KNOWLEDGE_EXCEPTION_KINDS = [
  "failed_ingestion",
  "stale_page",
  "expired_claim",
  "broken_evidence_link",
  "orphaned_claim",
  "dependency_mismatch",
  "page_hash_mismatch",
  "failed_build",
  "contradiction",
  "duplicate_entity",
  "weak_evidence",
  "low_quality_source",
  "oversized_page",
  "unused_page",
  "wiki_canonical_drift",
  "stale_instruction",
  "privacy_violation",
  "retrieval_regression",
  "retention_due",
] as const;

export type KnowledgeExceptionKind = (typeof KNOWLEDGE_EXCEPTION_KINDS)[number];
export type ExceptionSeverity = "low" | "medium" | "high" | "critical";

/**
 * Severity floors per kind. A detector may raise severity for a specific case
 * (a privacy violation on a restricted source, say) but may not lower it —
 * otherwise the noisiest checks quietly demote themselves out of view.
 */
export const KIND_MIN_SEVERITY: Record<KnowledgeExceptionKind, ExceptionSeverity> = {
  failed_ingestion: "medium",
  stale_page: "low",
  expired_claim: "high",
  broken_evidence_link: "high",
  orphaned_claim: "high",
  dependency_mismatch: "medium",
  page_hash_mismatch: "critical",
  failed_build: "medium",
  contradiction: "high",
  duplicate_entity: "low",
  weak_evidence: "medium",
  low_quality_source: "low",
  oversized_page: "low",
  unused_page: "low",
  wiki_canonical_drift: "critical",
  stale_instruction: "medium",
  privacy_violation: "critical",
  retrieval_regression: "high",
  retention_due: "medium",
};

const SEVERITY_ORDER: ExceptionSeverity[] = ["low", "medium", "high", "critical"];

/** Never below the kind's floor. */
export function effectiveSeverity(
  kind: KnowledgeExceptionKind,
  proposed?: ExceptionSeverity
): ExceptionSeverity {
  const floor = KIND_MIN_SEVERITY[kind];
  if (!proposed) return floor;
  return SEVERITY_ORDER.indexOf(proposed) > SEVERITY_ORDER.indexOf(floor) ? proposed : floor;
}

export interface RaiseKnowledgeExceptionInput {
  projectId?: string | null;
  maintenanceRunId?: string | null;
  kind: KnowledgeExceptionKind;
  severity?: ExceptionSeverity;
  subjectType: string;
  subjectId?: string | null;
  summary: string;
  detail?: Record<string, unknown>;
  recommendedAction?: string;
}

export interface RaisedException {
  id: string;
  created: boolean;
  /** How many maintenance runs have now seen this same unresolved finding. */
  occurrences: number;
}

/**
 * Open or refresh an exception. Idempotent on (kind, subject) while open, so a
 * detector may run every day without multiplying the feed.
 */
export async function raiseKnowledgeException(
  tx: Tx,
  input: RaiseKnowledgeExceptionInput
): Promise<RaisedException> {
  const severity = effectiveSeverity(input.kind, input.severity);
  const subjectId = input.subjectId ?? null;

  const [existing] = await tx`
    select id, detail from knowledge_exceptions
    where kind = ${input.kind} and subject_type = ${input.subjectType}
      and coalesce(subject_id, '00000000-0000-0000-0000-000000000000'::uuid)
        = coalesce(${subjectId}::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
      and status in ('open', 'acknowledged')
    for update
  `;

  if (existing) {
    const previous = (existing.detail as Record<string, unknown>) ?? {};
    const occurrences = Number(previous.occurrences ?? 1) + 1;
    await tx`
      update knowledge_exceptions set
        severity = ${severity},
        summary = ${input.summary},
        detail = ${tx.json({
          ...(input.detail ?? {}),
          occurrences,
          firstSeenAt: previous.firstSeenAt ?? new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
        } as never)},
        recommended_action = ${input.recommendedAction ?? ""},
        maintenance_run_id = ${input.maintenanceRunId ?? null}
      where id = ${existing.id}
    `;
    return { id: existing.id as string, created: false, occurrences };
  }

  const now = new Date().toISOString();
  const [row] = await tx`
    insert into knowledge_exceptions
      (project_id, maintenance_run_id, kind, severity, subject_type, subject_id,
       summary, detail, recommended_action)
    values
      (${input.projectId ?? null}, ${input.maintenanceRunId ?? null}, ${input.kind},
       ${severity}, ${input.subjectType}, ${subjectId}, ${input.summary},
       ${tx.json({ ...(input.detail ?? {}), occurrences: 1, firstSeenAt: now, lastSeenAt: now } as never)},
       ${input.recommendedAction ?? ""})
    returning id
  `;
  return { id: row!.id as string, created: true, occurrences: 1 };
}

/**
 * Close exceptions of a kind whose subjects no longer qualify.
 *
 * This is what makes the feed trustworthy in the other direction: a stale page
 * that got rebuilt must stop being reported, and it must stop being reported
 * *automatically*. Requiring a human to tick off a finding the system can see
 * is fixed is how backlogs become fiction.
 */
export async function autoResolveKnowledgeExceptions(
  tx: Tx,
  kind: KnowledgeExceptionKind,
  stillFailingSubjectIds: string[]
): Promise<number> {
  const rows = await tx`
    update knowledge_exceptions set
      status = 'resolved',
      resolution = 'No longer detected by the maintenance run that opened it.',
      resolved_at = now()
    where kind = ${kind} and status = 'open'
      ${
        stillFailingSubjectIds.length > 0
          ? tx`and not (subject_id = any(${stillFailingSubjectIds}::uuid[]))`
          : tx``
      }
    returning id
  `;
  return rows.length;
}

export interface KnowledgeExceptionRow {
  id: string;
  projectId: string | null;
  kind: string;
  severity: string;
  subjectType: string;
  subjectId: string | null;
  summary: string;
  recommendedAction: string;
  occurrences: number;
  createdAt: Date;
}

/** Open exceptions, worst first — the shape the Today feed renders. */
export async function openKnowledgeExceptions(
  projectId?: string | null,
  limit = 50
): Promise<KnowledgeExceptionRow[]> {
  const rows = await sql`
    select id, project_id, kind, severity, subject_type, subject_id, summary,
      recommended_action, detail, created_at
    from knowledge_exceptions
    where status = 'open'
      ${projectId ? sql`and project_id = ${projectId}` : sql``}
    order by case severity
      when 'critical' then 0 when 'high' then 1 when 'medium' then 2 else 3 end,
      created_at desc
    limit ${limit}
  `;
  return rows.map((row) => ({
    id: row.id as string,
    projectId: (row.projectId as string | null) ?? null,
    kind: row.kind as string,
    severity: row.severity as string,
    subjectType: row.subjectType as string,
    subjectId: (row.subjectId as string | null) ?? null,
    summary: row.summary as string,
    recommendedAction: (row.recommendedAction as string) ?? "",
    occurrences: Number((row.detail as Record<string, unknown>)?.occurrences ?? 1),
    createdAt: row.createdAt as Date,
  }));
}
