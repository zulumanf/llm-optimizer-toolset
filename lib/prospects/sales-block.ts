/**
 * Founder-facing "tangible step before price" (operating review 2026-09-07).
 * Reads the report's own change-first rows — derived deterministically from
 * the frozen evidence in lib/prospects/audit-mismatch.ts — and states ONE
 * action, one evidence-backed reason and one concrete place. Nothing is
 * invented here: when the report carries no evidence-backed row, there is
 * no block. No causality is claimed; the row's own "test" line says how we
 * would know.
 */
import { sql } from "@/db/client";
import type { AuditMismatchBlock, ChangeFirstRow } from "@/lib/prospects/audit-mismatch";

export interface FounderSalesBlock {
  prospectName: string;
  changeFirst: string;
  why: string;
  where: string;
  test: string;
  /** Rows the founder could offer next, in the report's priority order. */
  alsoConsider: string[];
  source: { auditId: string; publishedAt: Date | null };
}

/** Pure: the first evidence-backed change-first row becomes the block. */
export function founderSalesBlock(
  block: Pick<AuditMismatchBlock, "changeFirst">,
  prospectName: string,
  source: { auditId: string; publishedAt: Date | null }
): FounderSalesBlock | null {
  const rows: ChangeFirstRow[] = (block.changeFirst ?? []).filter((r) => r.change && r.observed && r.where);
  const first = rows[0];
  if (!first) return null;
  return {
    prospectName,
    changeFirst: first.change,
    why: first.observed.endsWith(".") ? first.observed : `${first.observed}.`,
    where: first.where,
    test: first.test,
    alsoConsider: rows.slice(1, 3).map((r) => r.title),
    source,
  };
}

/** Render for a reply draft or the founder's screen. Plain text, no claims
 * beyond the report's own rows. */
export function renderFounderSalesBlock(b: FounderSalesBlock): string {
  return [
    "WHAT I WOULD CHANGE FIRST",
    b.changeFirst,
    "",
    "WHY",
    b.why,
    "",
    "WHERE",
    b.where,
    "",
    "HOW WE WOULD KNOW",
    b.test,
  ].join("\n");
}

/** The block for a prospect, from its latest PUBLISHED report's frozen
 * mismatch section. Null when no published mismatch report exists or the
 * report derived no evidence-backed row. */
export async function salesBlockForProspect(prospectId: string): Promise<FounderSalesBlock | null> {
  const [row] = await sql`
    select a.id, a.published_at, p.business_name, a.snapshot->'mismatch' as block
    from prospect_audits a join prospects p on p.id = a.prospect_id
    where a.prospect_id = ${prospectId} and a.status = 'published' and a.snapshot ? 'mismatch'
    order by a.published_at desc nulls last limit 1
  `;
  if (!row?.block) return null;
  return founderSalesBlock(row.block as AuditMismatchBlock, row.businessName as string, {
    auditId: row.id as string,
    publishedAt: row.publishedAt ? new Date(row.publishedAt as Date) : null,
  });
}
