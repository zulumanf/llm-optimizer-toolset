import type { JSONValue } from "postgres";
import type { TransactionSql } from "@/db/client";

export interface AuditEntry {
  userId: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  detail?: JSONValue;
  /** Which client this action belongs to (plan 4.4). Optional — platform-
   * level actions have none; pass it wherever the caller knows it so the
   * per-client timeline stays complete going forward. */
  projectId?: string | null;
}

export interface ProjectActivityRow {
  id: string;
  action: string;
  entity: string;
  entityId: string | null;
  detail: Record<string, unknown>;
  at: Date;
  userName: string | null;
}

/**
 * The per-client work record (plan 5.2): every audit row stamped with this
 * project, newest first. Coverage note for callers' UI copy: rows written
 * before migration 055 were backfilled by entity join; anything that could
 * not be resolved stays platform-level and is absent here.
 */
export async function projectActivity(
  projectId: string,
  limit = 200
): Promise<ProjectActivityRow[]> {
  const { sql } = await import("@/db/client");
  return (await sql`
    select a.id, a.action, a.entity, a.entity_id, a.detail, a.at,
      u.name as user_name
    from audit_log a
    left join users u on u.id = a.user_id
    where a.project_id = ${projectId}
    order by a.at desc
    limit ${limit}
  `) as unknown as ProjectActivityRow[];
}

/** Insert an audit row inside the caller's transaction (docs/10: audit logs). */
export async function writeAudit(
  tx: TransactionSql,
  entry: AuditEntry
): Promise<void> {
  await tx`
    insert into audit_log (user_id, action, entity, entity_id, detail, project_id)
    values (
      ${entry.userId},
      ${entry.action},
      ${entry.entity},
      ${entry.entityId},
      ${tx.json(entry.detail ?? {})},
      ${entry.projectId ?? null}
    )
  `;
}
