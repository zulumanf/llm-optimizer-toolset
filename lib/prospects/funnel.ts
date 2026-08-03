/**
 * Acquisition funnel (spec 043, roadmap 3.7): how prospects move down the
 * stage ladder — ever-reached counts, stage-to-stage conversion, exits.
 * Derived on read from prospect_stage_history + current stages; sample
 * sizes always shown, rates null (never 0) when the base is empty.
 */
import { sql } from "@/db/client";
import {
  PROSPECT_STAGES,
  PROSPECT_EXIT_STAGES,
  type ProspectStage,
} from "@/lib/prospects/constants";

export const FUNNEL_VERSION = "acquisition-funnel-v1";

export interface FunnelStage {
  stage: ProspectStage;
  reached: number;
  /** reached ÷ previous stage's reached; null for the first stage or an
   * empty base. */
  conversionFromPrevious: number | null;
}

export interface FunnelReport {
  version: typeof FUNNEL_VERSION;
  totalProspects: number;
  stages: FunnelStage[];
  exits: { stage: ProspectStage; count: number }[];
}

export interface ProspectStageFacts {
  currentStage: ProspectStage;
  /** Every stage the prospect ever entered (history rows). */
  visitedStages: ProspectStage[];
}

const ladderIndex = new Map<string, number>(PROSPECT_STAGES.map((s, i) => [s, i]));

/** Pure funnel math. "Reached" = entered the stage or any later ladder
 * stage — a prospect now at `contracted` counts for every earlier stage. */
export function computeFunnel(prospects: ProspectStageFacts[]): FunnelReport {
  const maxIndex = (p: ProspectStageFacts): number => {
    const indices = [p.currentStage, ...p.visitedStages]
      .map((s) => ladderIndex.get(s))
      .filter((i): i is number => i !== undefined);
    return indices.length > 0 ? Math.max(...indices) : -1;
  };
  const maxes = prospects.map(maxIndex);
  const stages: FunnelStage[] = PROSPECT_STAGES.map((stage, index) => {
    const reached = maxes.filter((m) => m >= index).length;
    const previous = index === 0 ? null : maxes.filter((m) => m >= index - 1).length;
    return {
      stage,
      reached,
      conversionFromPrevious:
        previous === null || previous === 0 ? null : reached / previous,
    };
  });
  const exits = PROSPECT_EXIT_STAGES.map((stage) => ({
    stage,
    count: prospects.filter(
      (p) => p.currentStage === stage || p.visitedStages.includes(stage)
    ).length,
  })).filter((e) => e.count > 0);
  return {
    version: FUNNEL_VERSION,
    totalProspects: prospects.length,
    stages,
    exits,
  };
}

export async function acquisitionFunnel(launchId?: string): Promise<FunnelReport> {
  const rows = await sql`
    select p.id, p.stage,
      coalesce(array_agg(h.to_stage) filter (where h.to_stage is not null), '{}')
        as visited
    from prospects p
    left join prospect_stage_history h on h.prospect_id = p.id
    where p.archived_at is null
      and (${launchId ?? null}::uuid is null or p.launch_id = ${launchId ?? null})
    group by p.id, p.stage
  `;
  return computeFunnel(
    rows.map((r) => ({
      currentStage: r.stage as ProspectStage,
      visitedStages: (r.visited as ProspectStage[]) ?? [],
    }))
  );
}
