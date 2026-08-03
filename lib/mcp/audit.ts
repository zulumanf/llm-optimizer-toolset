/**
 * Invocation ledger for mutating MCP tools (spec 033, migration 039).
 * Append-only: outcomes are recorded after execution, so a keyed call that
 * races itself can double-execute in the window between them — the unique
 * index then surfaces the collision as a conflict instead of hiding it.
 * The stdio server serves one client sequentially, so this is theoretical.
 */
import { sql } from "@/db/client";

export interface RecordedEntity {
  entityKind: string;
  entityId: string;
}

/** The prior successful execution for this key, if any. */
export async function findReplay(
  tool: string,
  idempotencyKey: string
): Promise<RecordedEntity | null> {
  const [row] = await sql`
    select entity_kind, entity_id from mcp_invocations
    where tool = ${tool} and idempotency_key = ${idempotencyKey}
      and outcome = 'ok'
  `;
  if (!row) return null;
  return {
    entityKind: row.entityKind as string,
    entityId: row.entityId as string,
  };
}

export interface InvocationRecord {
  tool: string;
  actorId: string;
  argsHash: string;
  idempotencyKey: string | null;
  outcome: "ok" | "error";
  entityKind?: string;
  entityId?: string;
  error?: string;
}

/**
 * Returns false when the unique index rejected the row — meaning another
 * execution with the same key recorded success first. The caller reports
 * that collision to the operator; it never pretends the work didn't happen.
 */
export async function recordInvocation(rec: InvocationRecord): Promise<boolean> {
  try {
    await sql`
      insert into mcp_invocations
        (tool, actor_id, args_hash, idempotency_key, outcome,
         entity_kind, entity_id, error)
      values
        (${rec.tool}, ${rec.actorId}, ${rec.argsHash}, ${rec.idempotencyKey},
         ${rec.outcome}, ${rec.entityKind ?? null}, ${rec.entityId ?? null},
         ${rec.error ?? null})
    `;
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === "23505") return false;
    throw err;
  }
}
