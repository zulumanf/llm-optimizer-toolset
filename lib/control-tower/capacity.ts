/**
 * Operator capacity and measured automation (spec 019 Part D, Part 28/29).
 *
 * The question this answers is the one that decides whether the business
 * works: **can one operator support 5, 10, 20, or 50 clients?**
 *
 * The rule: report observed data, or report that there is not enough of it.
 * An extrapolation from two weeks of one client is a guess wearing a number's
 * clothes, so `supportableClients` is null below the observation threshold and
 * the UI says "insufficient data" rather than printing a confident lie.
 */
import { sql, type TransactionSql } from "@/db/client";

type Tx = TransactionSql | typeof sql;

/** A weekly operator budget. Configurable, stated, not smuggled into a formula. */
export const OPERATOR_WEEKLY_MINUTES = 40 * 60;

/**
 * Below this many human-touch observations, capacity is not reported.
 * Chosen so the estimate rests on more than a handful of decisions.
 */
export const MIN_OBSERVATIONS_FOR_CAPACITY = 20;

/**
 * Minutes charged to a human touch when we know it happened but not how long
 * it took. These are estimates and are labelled as such wherever displayed —
 * replace with measured intervals once decision timestamps accumulate.
 */
export const ESTIMATED_MINUTES = {
  approvalDecision: 8,
  exceptionResolution: 15,
  classificationReview: 3,
  manualOverride: 20,
} as const;

export interface CapacityReport {
  periodStart: string;
  periodEnd: string;
  activeClients: number;
  humanMinutesTotal: number;
  humanMinutesByClient: Record<string, number>;
  exceptionsTotal: number;
  approvalsTotal: number;
  manualOverrides: number;
  automationRate: number | null;
  /** null when observations are below MIN_OBSERVATIONS_FOR_CAPACITY. */
  supportableClients: number | null;
  observationCount: number;
  notes: string;
}

export async function computeCapacity(period: {
  start: string;
  end: string;
}): Promise<CapacityReport> {
  const weeks = Math.max(1, periodWeeks(period.start, period.end));

  const [clients] = await sql`
    select count(*) as n from projects where status = 'active' and kind = 'client'
  `;
  const activeClients = Number(clients?.n ?? 0);

  // Approvals: measured interval where we have one, estimate otherwise.
  const approvals = await sql`
    select project_id,
      count(*) as total,
      count(*) filter (where decided_at is not null) as decided,
      coalesce(sum(
        least(extract(epoch from (decided_at - requested_at)) / 60, 60)
      ) filter (where decided_at is not null), 0) as measured_minutes
    from workflow_approvals
    where requested_at >= ${period.start}::date and requested_at < ${period.end}::date + 1
    group by project_id
  `;

  const exceptions = await sql`
    select project_id, count(*) as total,
      count(*) filter (where resolved_at is not null) as resolved
    from workflow_exceptions
    where created_at >= ${period.start}::date and created_at < ${period.end}::date + 1
    group by project_id
  `;

  const reviews = await sql`
    select r.project_id, count(*) as n
    from mentions m
    join responses resp on resp.id = m.response_id
    join runs r on r.id = resp.run_id
    where m.reviewed_by is not null
      and r.started_at >= ${period.start}::date and r.started_at < ${period.end}::date + 1
    group by r.project_id
  `;

  const minutesByClient: Record<string, number> = {};
  const add = (projectId: string | null, minutes: number): void => {
    const key = projectId ?? "unassigned";
    minutesByClient[key] = (minutesByClient[key] ?? 0) + minutes;
  };

  let approvalsTotal = 0;
  let observations = 0;
  for (const row of approvals) {
    const total = Number(row.total ?? 0);
    const decided = Number(row.decided ?? 0);
    approvalsTotal += total;
    observations += decided;
    // Decided approvals contribute their measured interval (capped at an hour
    // so an approval left open over a weekend does not read as 60 hours of
    // work); undecided ones contribute the estimate.
    const measured = Number(row.measuredMinutes ?? 0);
    add(
      (row.projectId as string | null) ?? null,
      measured + (total - decided) * ESTIMATED_MINUTES.approvalDecision
    );
  }

  let exceptionsTotal = 0;
  for (const row of exceptions) {
    const total = Number(row.total ?? 0);
    const resolved = Number(row.resolved ?? 0);
    exceptionsTotal += total;
    observations += resolved;
    add((row.projectId as string | null) ?? null, resolved * ESTIMATED_MINUTES.exceptionResolution);
  }

  for (const row of reviews) {
    const n = Number(row.n ?? 0);
    observations += n;
    add((row.projectId as string | null) ?? null, n * ESTIMATED_MINUTES.classificationReview);
  }

  const [overrides] = await sql`
    select count(*) as n from workflow_transitions
    where actor = 'human' and at >= ${period.start}::date and at < ${period.end}::date + 1
  `;
  const manualOverrides = Number(overrides?.n ?? 0);

  const humanMinutesTotal = Object.values(minutesByClient).reduce((a, b) => a + b, 0);
  const automation = await automationRate(period);

  const clientsWithData = Object.keys(minutesByClient).filter((k) => k !== "unassigned").length;
  let supportableClients: number | null = null;
  let notes: string;

  if (observations < MIN_OBSERVATIONS_FOR_CAPACITY || clientsWithData === 0) {
    notes = `Insufficient data: ${observations} human-touch observation(s) across ${clientsWithData} client(s); ${MIN_OBSERVATIONS_FOR_CAPACITY} are needed before capacity is estimated.`;
  } else {
    const minutesPerClientPerWeek = humanMinutesTotal / clientsWithData / weeks;
    supportableClients =
      minutesPerClientPerWeek <= 0
        ? null
        : Math.round((OPERATOR_WEEKLY_MINUTES / minutesPerClientPerWeek) * 10) / 10;
    notes = `Observed ${minutesPerClientPerWeek.toFixed(1)} human minutes per client per week across ${clientsWithData} client(s) over ${weeks} week(s). Approval intervals are measured; exception and review minutes are estimates (see ESTIMATED_MINUTES).`;
  }

  return {
    periodStart: period.start,
    periodEnd: period.end,
    activeClients,
    humanMinutesTotal: Math.round(humanMinutesTotal),
    humanMinutesByClient: Object.fromEntries(
      Object.entries(minutesByClient).map(([k, v]) => [k, Math.round(v)])
    ),
    exceptionsTotal,
    approvalsTotal,
    manualOverrides,
    automationRate: automation.rate,
    supportableClients,
    observationCount: observations,
    notes,
  };
}

/**
 * Measured automation: the share of settled node runs that reached a terminal
 * state with no human transition. This is the instrument that keeps the
 * targets in docs/architecture honest — we report what happened, not what we
 * designed for.
 */
export async function automationRate(period: {
  start: string;
  end: string;
}): Promise<{ rate: number | null; settled: number; autonomous: number }> {
  const [row] = await sql`
    select
      count(*) as settled,
      count(*) filter (where not human_touch) as autonomous
    from node_runs
    where state in ('succeeded', 'failed_terminal', 'skipped', 'timed_out')
      and finished_at >= ${period.start}::date
      and finished_at < ${period.end}::date + 1
  `;
  const settled = Number(row?.settled ?? 0);
  const autonomous = Number(row?.autonomous ?? 0);
  return {
    rate: settled === 0 ? null : Math.round((autonomous / settled) * 1000) / 1000,
    settled,
    autonomous,
  };
}

/** Per-workflow automation, for the automation-performance view. */
export async function automationByWorkflow(period: {
  start: string;
  end: string;
}): Promise<{ key: string; settled: number; autonomous: number; rate: number }[]> {
  const rows = await sql`
    select d.key,
      count(*) as settled,
      count(*) filter (where not n.human_touch) as autonomous
    from node_runs n
    join workflow_runs r on r.id = n.workflow_run_id
    join workflow_versions v on v.id = r.version_id
    join workflow_definitions d on d.id = v.definition_id
    where n.state in ('succeeded', 'failed_terminal', 'skipped', 'timed_out')
      and n.finished_at >= ${period.start}::date
      and n.finished_at < ${period.end}::date + 1
    group by d.key
    order by settled desc
  `;
  return rows.map((r) => {
    const settled = Number(r.settled);
    const autonomous = Number(r.autonomous);
    return {
      key: r.key as string,
      settled,
      autonomous,
      rate: settled === 0 ? 0 : Math.round((autonomous / settled) * 1000) / 1000,
    };
  });
}

export async function recordCapacitySnapshot(tx: Tx, report: CapacityReport): Promise<string> {
  const [row] = await tx`
    insert into operator_capacity_snapshots (
      period_start, period_end, active_clients, human_minutes_total,
      human_minutes_by_client, exceptions_total, approvals_total, manual_overrides,
      automation_rate, supportable_clients, observation_count, notes
    ) values (
      ${report.periodStart}, ${report.periodEnd}, ${report.activeClients},
      ${report.humanMinutesTotal}, ${tx.json(report.humanMinutesByClient as never)},
      ${report.exceptionsTotal}, ${report.approvalsTotal}, ${report.manualOverrides},
      ${report.automationRate}, ${report.supportableClients},
      ${report.observationCount}, ${report.notes}
    )
    returning id
  `;
  return row!.id as string;
}

export function periodWeeks(start: string, end: string): number {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  return Math.max(1, Math.round(ms / (7 * 86_400_000)));
}
