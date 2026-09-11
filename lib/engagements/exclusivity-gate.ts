/**
 * Market exclusivity read-model for a prospect (spec 131): the same detection
 * the send gate runs (`detectLaunchConflicts`, spec 052 re-check), with the
 * client's own promoted prospect exempt. Used by the engagement page and
 * tests; the send gate itself lives in `sendProspectDraft`.
 */
import { sql } from "@/db/client";
import type { Conflict } from "@/lib/exclusivity/detect";
import { detectLaunchConflicts } from "@/lib/prospects/shared";

export interface ExclusivityGateVerdict {
  blocked: boolean;
  detail: string;
  conflicts: Conflict[];
}

/** Verdicts that block outreach: the prospect sits inside (or contains) a
 * protected market with overlapping service/segment. `possible` warns only. */
const BLOCKING_VERDICTS: ReadonlySet<Conflict["verdict"]> = new Set(["direct", "partial"]);

export async function exclusivityGateForProspect(
  prospectId: string,
  today = new Date().toISOString().slice(0, 10)
): Promise<ExclusivityGateVerdict> {
  const [prospect] = await sql`
    select p.promoted_project_id, l.market_id, l.service_category, l.price_segment
    from prospects p join market_launches l on l.id = p.launch_id
    where p.id = ${prospectId}
  `;
  if (!prospect) return { blocked: false, detail: "prospect not found — no market to check", conflicts: [] };
  const result = await detectLaunchConflicts(
    sql,
    {
      marketId: prospect.marketId as string,
      serviceCategory: (prospect.serviceCategory as string | null) ?? null,
      priceSegment: (prospect.priceSegment as string | null) ?? null,
    },
    { exceptProjectId: (prospect.promotedProjectId as string | null) ?? null, today }
  );
  const blocking = result.conflicts.filter((c) => BLOCKING_VERDICTS.has(c.verdict));
  if (blocking.length === 0) {
    return {
      blocked: false,
      detail:
        result.conflicts.length > 0
          ? `possible overlap only: ${result.conflicts[0]!.reason}`
          : "no live client protects this territory",
      conflicts: result.conflicts,
    };
  }
  return {
    blocked: true,
    detail: `Market exclusivity: ${blocking[0]!.reason} Outreach to a competing prospect in a protected market is refused.`,
    conflicts: blocking,
  };
}
