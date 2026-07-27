import type { JSONValue } from "postgres";
import type { TransactionSql } from "@/db/client";

export interface AuditEntry {
  userId: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  detail?: JSONValue;
}

/** Insert an audit row inside the caller's transaction (docs/10: audit logs). */
export async function writeAudit(
  tx: TransactionSql,
  entry: AuditEntry
): Promise<void> {
  await tx`
    insert into audit_log (user_id, action, entity, entity_id, detail)
    values (
      ${entry.userId},
      ${entry.action},
      ${entry.entity},
      ${entry.entityId},
      ${tx.json(entry.detail ?? {})}
    )
  `;
}
