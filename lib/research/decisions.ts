/**
 * Staged-research decision kernel (cleanup 2026-08-17). Every Perplexity
 * research feature stages rows with the same lifecycle — pending →
 * approved/installed/rejected, decided_by/decided_at stamped, an audit row
 * written, already-decided refused — and each module had grown its own
 * copy. One transition helper; the MATERIALIZATION (what approval actually
 * creates) stays in each domain module where it belongs.
 *
 * Table names pass through sql() identifier interpolation — callers are
 * compile-time constants, never user input.
 */
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { ClassifiedError } from "@/lib/errors";
import type { CurrentUser } from "@/lib/auth";
import type { AuditEntry } from "@/db/audit";

export async function decideStagedRow(args: {
  table: "enrichment_proposals" | "market_pack_drafts" | "prompt_suggestions";
  id: string;
  user: CurrentUser;
  /** The terminal status this decision applies. */
  to: "approved" | "rejected" | "installed" | "dismissed";
  /** Audit action, e.g. "prospect.enrichment_approve". */
  auditAction: string;
  auditEntity: string;
  auditDetail: AuditEntry["detail"];
}): Promise<void> {
  await sql.begin(async (tx) => {
    const rows = await tx`
      update ${tx(args.table)}
      set status = ${args.to}, decided_by = ${args.user.id}, decided_at = now()
      where id = ${args.id} and status = 'pending'
      returning id
    `;
    if (!rows[0]) {
      throw new ClassifiedError("conflict", "Not found or already decided.");
    }
    await writeAudit(tx, {
      userId: args.user.id,
      action: args.auditAction,
      entity: args.auditEntity,
      entityId: args.id,
      detail: args.auditDetail,
    });
  });
}
