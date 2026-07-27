import { sql } from "@/db/client";

export interface ScoreRow {
  companyId: string;
  companyName: string;
  isSelf: boolean;
  metric: string;
  provider: string;
  value: string;
  sampleSize: number;
  scoringVersion: string;
  computedAt: Date;
}

export async function listScoresForRun(runId: string): Promise<ScoreRow[]> {
  return sql<ScoreRow[]>`
    select s.company_id, c.name as company_name, c.is_self,
      s.metric, s.provider, s.value, s.sample_size, s.scoring_version, s.computed_at
    from scores s
    join companies c on c.id = s.company_id
    where s.run_id = ${runId}
    order by c.is_self desc, c.name asc, s.metric asc, s.provider asc
  `;
}
