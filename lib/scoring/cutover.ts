/**
 * Scoring cutover (release 151): verify v1.2 (in scores_staging) is complete
 * and consistent, then — in one transaction under the exclusive scoring
 * lock — copy staging → scores and flip `scoring_state.read_version`.
 * Rollback flips readers back (safe: the legacy v1.1 writer keeps running
 * until retired). Application-image compatibility: BEFORE the cutover a
 * pre-151 image may be redeployed (scores holds v1.1 only); AFTER it, only
 * post-151 images (which pin the read version) are compatible. Every change appends a scoring_state_history row
 * carrying the verification that justified it.
 */
import { sql, type TransactionSql } from "@/db/client";
import { scoringState, SCORING_WRITE_LOCK_KEY } from "@/db/scores";
import { SCORING_VERSION } from "@/lib/constants";
import { LEGACY_SCORING_VERSION } from "@/lib/scoring/legacy-v11";

/** Metrics whose formula is identical in v1.1 and v1.2 for a single-
 * instrument provider in a run with no cohort (same answers, same
 * universe). citation_score is excluded: v1.2 fixed the domain rule. */
export const PARITY_METRICS = [
  "mention_rate",
  "recommendation_rate",
  "first_position_rate",
  "top_three_rate",
  "position_score",
  "sentiment_index",
] as const;
export const PARITY_TOLERANCE = 1e-6;

export interface CutoverVerification {
  checkedAt: string;
  runsWithLegacy: number;
  runsMissingV12Scores: string[];
  runsMissingV12Estimates: string[];
  parityChecked: number;
  parityDifferences: { runId: string; companyId: string; metric: string; provider: string; v11: number; v12: number }[];
  ok: boolean;
}

export async function verifyCutover(): Promise<CutoverVerification> {
  const legacyRuns = await sql`
    select distinct s.run_id from scores s join runs r on r.id = s.run_id
    where s.scoring_version = ${LEGACY_SCORING_VERSION} and r.status in ('completed', 'partial')
  `;
  // v1.2 compatibility rows live in scores_staging until the cutover copies
  // them (and in scores afterwards); either location counts as covered.
  const missingScores = await sql`
    select distinct s.run_id from scores s join runs r on r.id = s.run_id
    where s.scoring_version = ${LEGACY_SCORING_VERSION} and r.status in ('completed', 'partial')
      and not exists (select 1 from scores_staging n where n.run_id = s.run_id and n.scoring_version = ${SCORING_VERSION})
      and not exists (select 1 from scores n where n.run_id = s.run_id and n.scoring_version = ${SCORING_VERSION})
    order by s.run_id
  `;
  const missingEstimates = await sql`
    select distinct s.run_id from scores s join runs r on r.id = s.run_id
    where s.scoring_version = ${LEGACY_SCORING_VERSION} and r.status in ('completed', 'partial')
      and not exists (select 1 from score_estimates e where e.run_id = s.run_id and e.scoring_version = ${SCORING_VERSION})
    order by s.run_id
  `;
  // Parity on comparable rows: the v1.2 provider row exists only for a
  // single-instrument provider; restrict to runs whose estimates used no cohort.
  const parity = await sql`
    select o.run_id, o.company_id, o.metric, o.provider, o.value::float8 as v11, n.value::float8 as v12
    from scores o
    join scores_staging n on n.run_id = o.run_id and n.company_id = o.company_id and n.metric = o.metric
      and n.provider = o.provider and n.scoring_version = ${SCORING_VERSION}
    where o.scoring_version = ${LEGACY_SCORING_VERSION}
      and o.provider <> 'all'
      and o.metric = any(${[...PARITY_METRICS]})
      and not exists (select 1 from score_estimates e where e.run_id = o.run_id and e.cohort_id is not null)
  `;
  const differences = parity
    .filter((r) => Math.abs(Number(r.v11) - Number(r.v12)) > PARITY_TOLERANCE)
    .map((r) => ({
      runId: r.runId as string,
      companyId: r.companyId as string,
      metric: r.metric as string,
      provider: r.provider as string,
      v11: Number(r.v11),
      v12: Number(r.v12),
    }));
  const runsMissingV12Scores = missingScores.map((r) => r.runId as string);
  const runsMissingV12Estimates = missingEstimates.map((r) => r.runId as string);
  return {
    checkedAt: new Date().toISOString(),
    runsWithLegacy: legacyRuns.length,
    runsMissingV12Scores,
    runsMissingV12Estimates,
    parityChecked: parity.length,
    parityDifferences: differences,
    ok: runsMissingV12Scores.length === 0 && runsMissingV12Estimates.length === 0 && differences.length === 0,
  };
}

class CutoverRaceError extends Error {
  constructor(readonly runs: number) {
    super(`${runs} run(s) became uncovered between verification and the flip`);
  }
}

export interface CutoverOptions {
  /** Accept runs without v1.2 (they disappear from current views). */
  acceptUncovered?: boolean;
  /** Accept parity differences (e.g. stale v1.1 rows after later reviews). */
  acceptDifferences?: boolean;
  reason: string;
  changedBy: string;
}

export async function applyCutover(
  opts: CutoverOptions
): Promise<{ applied: boolean; verification: CutoverVerification; refusal?: string; copiedRows?: number }> {
  const verification = await verifyCutover();
  const uncovered = verification.runsMissingV12Scores.length + verification.runsMissingV12Estimates.length;
  if (uncovered > 0 && !opts.acceptUncovered) {
    return { applied: false, verification, refusal: `${uncovered} run(s) lack v1.2 rows; rescore them or pass --accept-uncovered.` };
  }
  if (verification.parityDifferences.length > 0 && !opts.acceptDifferences) {
    return {
      applied: false,
      verification,
      refusal: `${verification.parityDifferences.length} v1.1/v1.2 parity difference(s); inspect, then pass --accept-differences.`,
    };
  }
  let copied: number;
  try {
    copied = await sql.begin(async (tx) => {
    // Exclusive: no scoring transaction is mid-write while we copy and flip.
    await tx`select pg_advisory_xact_lock(${SCORING_WRITE_LOCK_KEY})`;
    // Re-check coverage under the lock: a run scored after verifyCutover()
    // must not slip through uncovered.
    if (!opts.acceptUncovered) {
      const [late] = await tx`
        select count(*)::int as n from (
          select distinct s.run_id from scores s join runs r on r.id = s.run_id
          where s.scoring_version = ${LEGACY_SCORING_VERSION} and r.status in ('completed', 'partial')
            and not exists (select 1 from scores_staging n where n.run_id = s.run_id and n.scoring_version = ${SCORING_VERSION})
            and not exists (select 1 from scores n where n.run_id = s.run_id and n.scoring_version = ${SCORING_VERSION})
        ) x
      `;
      if (Number(late?.n ?? 0) > 0) throw new CutoverRaceError(Number(late?.n));
    }
    const inserted = await tx`
      insert into scores (run_id, company_id, metric, provider, value, sample_size, scoring_version, computed_at)
      select run_id, company_id, metric, provider, value, sample_size, scoring_version, computed_at
      from scores_staging where scoring_version = ${SCORING_VERSION}
      on conflict (run_id, company_id, metric, provider, scoring_version) do nothing
      returning id
    `;
    await writeState(tx, { readVersion: "v1.2", writeLegacy: true, reason: opts.reason, changedBy: opts.changedBy, verification: { ...verification, copiedRows: inserted.length } });
    return inserted.length;
    });
  } catch (err) {
    if (err instanceof CutoverRaceError) {
      return { applied: false, verification, refusal: `${err.message}; rescore them and re-run.` };
    }
    throw err;
  }
  return { applied: true, verification, copiedRows: copied };
}

export async function rollbackCutover(reason: string, changedBy: string): Promise<void> {
  const state = await scoringState();
  if (!state.writeLegacy) {
    throw new Error("The legacy v1.1 writer was retired; runs since then have no v1.1 rows, so a rollback would hide them. Re-enable it and rescore first.");
  }
  await setScoringState({ readVersion: "v1.1", writeLegacy: true, reason, changedBy, verification: null });
}

/** Stop writing v1.1. Only after the cutover has held. */
export async function retireLegacyWriter(reason: string, changedBy: string): Promise<void> {
  const state = await scoringState();
  if (state.readVersion !== "v1.2") throw new Error("Readers still use v1.1; flip the read version first.");
  await setScoringState({ readVersion: "v1.2", writeLegacy: false, reason, changedBy, verification: null });
}

interface StateChange {
  readVersion: "v1.1" | "v1.2";
  writeLegacy: boolean;
  reason: string;
  changedBy: string;
  verification: Record<string, unknown> | CutoverVerification | null;
}

async function writeState(tx: TransactionSql, input: StateChange): Promise<void> {
  await tx`
    update scoring_state set read_version = ${input.readVersion}, write_legacy = ${input.writeLegacy}, updated_at = now()
    where id = 1
  `;
  await tx`
    insert into scoring_state_history (read_version, write_legacy, reason, verification, changed_by)
    values (${input.readVersion}, ${input.writeLegacy}, ${input.reason},
      ${tx.json((input.verification ?? {}) as never)}, ${input.changedBy})
  `;
}

async function setScoringState(input: StateChange): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${SCORING_WRITE_LOCK_KEY})`;
    await writeState(tx, input);
  });
}
