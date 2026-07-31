/**
 * Artifact access logging (spec 014, docs/10).
 *
 * Reading a page is not the same as taking a copy of a client's raw evidence
 * off the platform. The audit log records what changed; this records what
 * *left*. Without it, "who downloaded the evidence export" is unanswerable,
 * which is precisely the question that gets asked after something goes wrong.
 *
 * Insert-only, enforced by a trigger: an access record that can be edited is
 * not an access record.
 */
import { sql, type TransactionSql } from "@/db/client";
import { log } from "@/lib/logger";

type Tx = TransactionSql | typeof sql;

export type ArtifactType =
  | "evidence_artifact"
  | "evidence_export"
  | "source_artifact"
  | "report";

export interface RecordAccessInput {
  userId: string | null;
  artifactType: ArtifactType;
  artifactId: string;
  projectId?: string | null;
  action?: "download" | "view";
  /** From request headers; both optional and both best-effort. */
  ipAddress?: string | null;
  userAgent?: string | null;
}

export async function recordArtifactAccess(
  tx: Tx,
  input: RecordAccessInput
): Promise<void> {
  await tx`
    insert into artifact_access_log
      (user_id, artifact_type, artifact_id, project_id, action, ip_address, user_agent)
    values
      (${input.userId}, ${input.artifactType}, ${input.artifactId},
       ${input.projectId ?? null}, ${input.action ?? "download"},
       ${input.ipAddress ?? null}, ${input.userAgent ?? null})
  `;
}

/**
 * Fire-and-forget variant for route handlers streaming a file.
 *
 * Deliberately non-blocking and deliberately loud on failure: a download must
 * not 500 because logging failed, but a silently unlogged download would leave
 * a hole in the record that nobody notices until it matters.
 */
export function recordArtifactAccessAsync(input: RecordAccessInput): void {
  void sql
    .begin((tx) => recordArtifactAccess(tx, input))
    .catch((err) =>
      log("error", "security.access_log_failed", {
        artifactType: input.artifactType,
        artifactId: input.artifactId,
        error: err instanceof Error ? err.message : "unknown",
      })
    );
}

export interface AccessLogRow {
  id: string;
  userId: string | null;
  userEmail: string | null;
  artifactType: string;
  artifactId: string;
  action: string;
  accessedAt: Date;
}

export async function recentArtifactAccess(
  projectId?: string | null,
  limit = 100
): Promise<AccessLogRow[]> {
  const rows = await sql`
    select a.id, a.user_id, u.email as user_email, a.artifact_type,
      a.artifact_id, a.action, a.accessed_at
    from artifact_access_log a
    left join users u on u.id = a.user_id
    where true ${projectId ? sql`and a.project_id = ${projectId}` : sql``}
    order by a.accessed_at desc
    limit ${limit}
  `;
  return rows.map((row) => ({
    id: row.id as string,
    userId: (row.userId as string | null) ?? null,
    userEmail: (row.userEmail as string | null) ?? null,
    artifactType: row.artifactType as string,
    artifactId: row.artifactId as string,
    action: row.action as string,
    accessedAt: row.accessedAt as Date,
  }));
}
