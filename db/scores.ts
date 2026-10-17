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

/**
 * Release 151 cutover: the scoring version every `scores` READER must use.
 * A SQL fragment (not a JS constant) so a cutover flip in scoring_state is
 * atomic for every query at once, with no redeploy. Writers stamp their own
 * version (SCORING_VERSION / LEGACY_SCORING_VERSION).
 * tests/unit/scores-read-version.test.ts fails any new value reader of
 * `scores` that does not use it.
 */
/** Falls back to v1.1 if the state row is ever missing: an absent switch
 * must never make every reader see nothing. */
export const READ_SCORING_VERSION = sql`coalesce((select read_version from scoring_state where id = 1), 'v1.1')`;

/** Advisory lock: scoring writers hold it SHARED inside their transaction;
 * the cutover holds it EXCLUSIVE while copying staging → scores and flipping
 * the switch, so no write can straddle the flip. */
export const SCORING_WRITE_LOCK_KEY = 727_274_152;

export interface ScoringState {
  readVersion: "v1.1" | "v1.2";
  writeLegacy: boolean;
}

export async function scoringState(): Promise<ScoringState> {
  const [row] = await sql<ScoringState[]>`select read_version, write_legacy from scoring_state where id = 1`;
  return row ?? { readVersion: "v1.1", writeLegacy: true };
}
