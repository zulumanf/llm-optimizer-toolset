/**
 * Outcome measurement sweep (spec 034). action_outcomes were recorded but
 * never measured — every row parked at 'insufficient_measurement' forever,
 * which hollowed out the docs/07 learning loop. The sweep rides the
 * automation heartbeat: idempotent by construction (measureAction is
 * write-once behind FOR UPDATE), so no window claim is needed.
 *
 * Measurement sources (DECISIONS 2026-08-01): visibility = the subject
 * company's mention_rate (provider 'all', current scoring version);
 * citations = the subject's owned-citation count in the compared run.
 * Traffic/leads/pipeline stay null until a real data source exists.
 */
import { sql } from "@/db/client";
import { getSubjectCompany } from "@/db/companies";
import { SCORING_VERSION } from "@/lib/constants";
import { measureAction, OUTCOME_MATERIALITY_THRESHOLD } from "@/lib/outcomes/graph";
import { log } from "@/lib/logger";

/** Actions with no expected_days_to_impact are due after this many days. */
export const DEFAULT_DAYS_TO_IMPACT = 30;
/** Past due by this much with no post-action scored run → settle as
 * insufficient_measurement instead of retrying forever. */
export const MEASUREMENT_GIVE_UP_DAYS = 60;
/** Another action within ± this window is a confounder (half of
 * attribution's CONFOUND_WINDOW_DAYS — the same idea, per side). */
export const CONFOUNDER_WINDOW_DAYS = 42;

/** The date an action counts from: completion if known, else creation. */
export function actionDate(row: { completedOn: Date | null; createdAt: Date }): Date {
  return row.completedOn ?? row.createdAt;
}

export function isDue(
  row: { completedOn: Date | null; createdAt: Date; expectedDaysToImpact: number | null },
  today: Date
): boolean {
  const start = actionDate(row).getTime();
  const days = row.expectedDaysToImpact ?? DEFAULT_DAYS_TO_IMPACT;
  return today.getTime() - start >= days * 86_400_000;
}

export function isPastGiveUp(
  row: { completedOn: Date | null; createdAt: Date; expectedDaysToImpact: number | null },
  today: Date
): boolean {
  const start = actionDate(row).getTime();
  const days = (row.expectedDaysToImpact ?? DEFAULT_DAYS_TO_IMPACT) + MEASUREMENT_GIVE_UP_DAYS;
  return today.getTime() - start >= days * 86_400_000;
}

interface RunSnapshot {
  runId: string;
  mentionRate: number | null;
  ownedCitations: number;
}

/** The subject's numbers from the latest scored run strictly before/after a
 * moment — pinned to the current scoring version, because comparing across
 * versions is the forbidden read. Null run = nothing comparable exists. */
async function snapshotNearest(
  projectId: string,
  companyId: string,
  moment: Date,
  direction: "before" | "after"
): Promise<RunSnapshot | null> {
  const [run] = await sql`
    select r.id from runs r
    where r.project_id = ${projectId}
      and exists (select 1 from scores s
        where s.run_id = r.id and s.scoring_version = ${SCORING_VERSION})
      and ${direction === "before"
        ? sql`r.started_at < ${moment}`
        : sql`r.started_at > ${moment}`}
    order by r.started_at ${direction === "before" ? sql`desc` : sql`asc`}
    limit 1
  `;
  if (!run) return null;
  const [score] = await sql`
    select value from scores
    where run_id = ${run.id} and company_id = ${companyId}
      and metric = 'mention_rate' and provider = 'all'
      and scoring_version = ${SCORING_VERSION}
  `;
  const [cites] = await sql`
    select count(*)::int as count
    from response_citations c
    join responses r on r.id = c.response_id
    where r.run_id = ${run.id} and c.company_id = ${companyId}
  `;
  return {
    runId: run.id as string,
    mentionRate: score ? Number(score.value) : null,
    ownedCitations: Number(cites?.count ?? 0),
  };
}

export interface SweepResult {
  due: number;
  measured: number;
  settledUnmeasurable: number;
  waiting: number;
  skippedNoSubject: number;
}

export async function measureDueActionOutcomes(
  today: Date = new Date()
): Promise<SweepResult> {
  const rows = await sql`
    select id, project_id, action_type, completed_on, created_at,
      expected_days_to_impact
    from action_outcomes
    where measured_at is null
    order by created_at asc
  `;
  const result: SweepResult = {
    due: 0,
    measured: 0,
    settledUnmeasurable: 0,
    waiting: 0,
    skippedNoSubject: 0,
  };

  for (const row of rows) {
    const shape = {
      completedOn: (row.completedOn as Date | null) ?? null,
      createdAt: row.createdAt as Date,
      expectedDaysToImpact:
        row.expectedDaysToImpact == null ? null : Number(row.expectedDaysToImpact),
    };
    if (!isDue(shape, today)) continue;
    result.due += 1;

    const settleUnmeasurable = async () => {
      // All-null afters settle honestly as insufficient_measurement and end
      // the retry loop — "we waited, nothing became comparable" is a result.
      await sql.begin((tx) =>
        measureAction(tx, {
          actionOutcomeId: row.id as string,
          after: {},
          materialityThreshold: OUTCOME_MATERIALITY_THRESHOLD,
        })
      );
      result.settledUnmeasurable += 1;
    };

    const subject = await getSubjectCompany(row.projectId as string);
    if (!subject) {
      if (isPastGiveUp(shape, today)) await settleUnmeasurable();
      else result.skippedNoSubject += 1;
      continue;
    }

    const moment = actionDate(shape);
    const after = await snapshotNearest(
      row.projectId as string,
      subject.id,
      moment,
      "after"
    );
    if (!after) {
      if (isPastGiveUp(shape, today)) await settleUnmeasurable();
      else result.waiting += 1;
      continue;
    }
    const before = await snapshotNearest(
      row.projectId as string,
      subject.id,
      moment,
      "before"
    );

    // Other actions in the same project whose window overlaps this one.
    const overlapping = await sql`
      select action_type from action_outcomes
      where project_id = ${row.projectId} and id <> ${row.id}
        and abs(extract(epoch from (
          coalesce(completed_on::timestamptz, created_at) -
          ${moment}
        ))) <= ${CONFOUNDER_WINDOW_DAYS * 86_400}
    `;
    const confounders = [...new Set(overlapping.map(
      (o) => `overlapping action: ${o.actionType as string}`
    ))];

    const verdict = await sql.begin((tx) =>
      measureAction(tx, {
        actionOutcomeId: row.id as string,
        after: {
          visibility: after.mentionRate,
          citations: after.ownedCitations,
        },
        before: before
          ? { visibility: before.mentionRate, citations: before.ownedCitations }
          : undefined,
        confounders,
        materialityThreshold: OUTCOME_MATERIALITY_THRESHOLD,
      })
    );
    result.measured += 1;
    log("info", "outcomes.measured", {
      actionOutcomeId: row.id,
      projectId: row.projectId,
      label: verdict.label,
      reason: verdict.reason,
    });
  }
  return result;
}
