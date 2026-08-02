import { sql } from "@/db/client";

export interface GapFindingRow {
  id: string;
  runId: string;
  runLabel: string;
  promptCategory: string | null;
  gapType: string;
  finding: string;
  detail: unknown;
  severity: string;
  opportunityScore: number;
  detectorVersion: string;
  status: string;
  createdAt: Date;
}

/** Findings for a project, open first then by opportunity — the same order
 * the gaps page renders. Optional run filter for "what did this run find". */
export async function listGapFindings(
  projectId: string,
  runId?: string
): Promise<GapFindingRow[]> {
  return sql<GapFindingRow[]>`
    select f.id, f.run_id, r.label as run_label, f.prompt_category,
      f.gap_type, f.finding, f.detail, f.severity,
      f.opportunity_score, f.detector_version, f.status, f.created_at
    from gap_findings f
    join runs r on r.id = f.run_id
    where f.project_id = ${projectId}
      ${runId ? sql`and f.run_id = ${runId}` : sql``}
    order by f.status = 'open' desc, f.opportunity_score desc, f.created_at desc
    limit 50
  `;
}
