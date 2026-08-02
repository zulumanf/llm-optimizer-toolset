import { sql } from "@/db/client";

export interface DiscoveryRunSummaryRow {
  id: string;
  status: string;
  candidatesFound: number;
  candidatesIngested: number;
  candidatesSkipped: number;
  claimsProposed: number;
  contradictionsRaised: number;
  costMicroUsd: number;
  stopReason: string | null;
  startedAt: Date;
}

/** Recent discovery runs for a project — the sources page's history panel. */
export async function listDiscoveryRuns(
  projectId: string,
  limit = 5
): Promise<DiscoveryRunSummaryRow[]> {
  return sql<DiscoveryRunSummaryRow[]>`
    select id, status, candidates_found, candidates_ingested,
      candidates_skipped, claims_proposed, contradictions_raised,
      cost_micro_usd, stop_reason, started_at
    from discovery_runs
    where project_id = ${projectId}
    order by started_at desc
    limit ${limit}
  `;
}
