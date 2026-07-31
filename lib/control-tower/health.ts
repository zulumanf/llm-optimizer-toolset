/**
 * Client health (spec 019 Part C).
 *
 * The design constraint that shaped every line here: **no mysterious score.**
 * A health number is only allowed to exist alongside its components, their
 * weights, the period they cover, what was missing, and how confident the
 * result is. A component with no data is `null` — it lowers confidence, it
 * never quietly scores zero and drags a healthy client into the red.
 */
import { sql, type TransactionSql } from "@/db/client";

type Tx = TransactionSql | typeof sql;

export const HEALTH_WEIGHTS_VERSION = "v1.0";

export const HEALTH_COMPONENTS = [
  "visibility_trend",
  "authority_progress",
  "reputation_accuracy",
  "execution_velocity",
  "approval_velocity",
  "attribution_completeness",
  "lead_outcomes",
  "integration_health",
  "scope_utilisation",
  "client_engagement",
  "renewal_risk",
] as const;
export type HealthComponent = (typeof HEALTH_COMPONENTS)[number];

export const HEALTH_WEIGHTS: Record<HealthComponent, number> = {
  visibility_trend: 0.2,
  authority_progress: 0.12,
  reputation_accuracy: 0.15,
  execution_velocity: 0.1,
  approval_velocity: 0.08,
  attribution_completeness: 0.05,
  lead_outcomes: 0.05,
  integration_health: 0.08,
  scope_utilisation: 0.05,
  client_engagement: 0.05,
  renewal_risk: 0.07,
};

export interface ComponentResult {
  name: HealthComponent;
  weight: number;
  /** null means "no data for this period" — never coerced to 0. */
  score: number | null;
  detail: string;
  evidence: Record<string, unknown>;
}

export interface HealthSnapshot {
  projectId: string;
  periodStart: string;
  periodEnd: string;
  weightsVersion: string;
  overall: number | null;
  components: ComponentResult[];
  missing: HealthComponent[];
  confidence: number;
}

/**
 * Weighted mean over PRESENT components only, re-normalised by their weight
 * share. Confidence is that weight share — a client scored on 40% of the
 * inputs gets a 0.4-confidence number, and the UI says so.
 */
export function combine(components: ComponentResult[]): {
  overall: number | null;
  confidence: number;
  missing: HealthComponent[];
} {
  const present = components.filter((c) => c.score !== null);
  const missing = components.filter((c) => c.score === null).map((c) => c.name);
  const presentWeight = present.reduce((sum, c) => sum + c.weight, 0);
  const totalWeight = components.reduce((sum, c) => sum + c.weight, 0);
  if (present.length === 0 || presentWeight === 0) {
    return { overall: null, confidence: 0, missing };
  }
  const overall = present.reduce((sum, c) => sum + c.weight * (c.score ?? 0), 0) / presentWeight;
  return {
    overall: Math.round(overall * 1000) / 1000,
    confidence: Math.round((presentWeight / totalWeight) * 1000) / 1000,
    missing,
  };
}

interface Period {
  start: string;
  end: string;
}

/** Compute one client's health for a period. Reads only that client's data. */
export async function computeClientHealth(
  projectId: string,
  period: Period
): Promise<HealthSnapshot> {
  const components: ComponentResult[] = [
    await visibilityTrend(projectId, period),
    await authorityProgress(projectId, period),
    await reputationAccuracy(projectId, period),
    await executionVelocity(projectId, period),
    await approvalVelocity(projectId, period),
    await attributionCompleteness(projectId, period),
    await leadOutcomes(projectId, period),
    await integrationHealth(projectId, period),
    await scopeUtilisation(projectId, period),
    await clientEngagement(projectId, period),
    await renewalRisk(projectId, period),
  ];
  const { overall, confidence, missing } = combine(components);
  return {
    projectId,
    periodStart: period.start,
    periodEnd: period.end,
    weightsVersion: HEALTH_WEIGHTS_VERSION,
    overall,
    components,
    missing,
    confidence,
  };
}

export async function recordHealthSnapshot(
  tx: Tx,
  snapshot: HealthSnapshot
): Promise<string> {
  const [row] = await tx`
    insert into client_health_snapshots (
      project_id, period_start, period_end, weights_version, overall,
      components, missing, confidence, evidence
    ) values (
      ${snapshot.projectId}, ${snapshot.periodStart}, ${snapshot.periodEnd},
      ${snapshot.weightsVersion}, ${snapshot.overall},
      ${tx.json(snapshot.components as never)}, ${snapshot.missing},
      ${snapshot.confidence},
      ${tx.json(
        Object.fromEntries(snapshot.components.map((c) => [c.name, c.evidence])) as never
      )}
    )
    returning id
  `;
  return row!.id as string;
}

// ------------------------------------------------------------- components

const component = (
  name: HealthComponent,
  score: number | null,
  detail: string,
  evidence: Record<string, unknown> = {}
): ComponentResult => ({ name, weight: HEALTH_WEIGHTS[name], score, detail, evidence });

/** Recommendation rate this period vs the previous one, mapped onto 0..1. */
async function visibilityTrend(projectId: string, period: Period): Promise<ComponentResult> {
  const rows = await sql`
    select s.value, r.started_at
    from scores s
    join runs r on r.id = s.run_id
    join projects p on p.id = r.project_id
    where r.project_id = ${projectId}
      and s.company_id = p.subject_company_id
      and s.metric = 'recommendation_rate' and s.provider = 'all'
      and r.started_at >= ${period.start}::date - interval '60 days'
      and r.started_at < ${period.end}::date + interval '1 day'
    order by r.started_at asc
  `;
  if (rows.length === 0) {
    return component("visibility_trend", null, "no scored runs in or before this period");
  }
  const current = Number(rows[rows.length - 1]!.value);
  if (rows.length === 1) {
    // One measurement is a level, not a trend. Report the level, say so.
    return component(
      "visibility_trend",
      Math.min(1, current),
      `single measurement (${(current * 100).toFixed(0)}%) — no trend available yet`,
      { samples: 1, current }
    );
  }
  const previous = Number(rows[rows.length - 2]!.value);
  const delta = current - previous;
  // Level carries the score; the delta nudges it ±0.15 so a client who is low
  // but climbing does not read the same as one who is low and falling.
  const score = Math.max(0, Math.min(1, current + Math.max(-0.15, Math.min(0.15, delta))));
  return component(
    "visibility_trend",
    Math.round(score * 1000) / 1000,
    `recommendation rate ${(current * 100).toFixed(0)}% (${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(0)}pp vs previous run)`,
    { current, previous, delta, samples: rows.length }
  );
}

/** Actions actually shipped vs opportunities identified. */
async function authorityProgress(projectId: string, period: Period): Promise<ComponentResult> {
  const [row] = await sql`
    select
      (select count(*) from gap_findings
        where project_id = ${projectId} and created_at < ${period.end}::date + 1) as gaps,
      (select count(*) from gap_findings
        where project_id = ${projectId} and status = 'task_created'
          and created_at < ${period.end}::date + 1) as actioned,
      (select count(*) from content_assets
        where project_id = ${projectId} and status = 'published') as published
  `;
  const gaps = Number(row?.gaps ?? 0);
  const actioned = Number(row?.actioned ?? 0);
  const published = Number(row?.published ?? 0);
  if (gaps === 0) {
    return component("authority_progress", null, "no gap findings recorded yet");
  }
  const score = Math.min(1, actioned / gaps);
  return component(
    "authority_progress",
    Math.round(score * 1000) / 1000,
    `${actioned} of ${gaps} findings turned into work; ${published} asset(s) published`,
    { gaps, actioned, published }
  );
}

/** Open factual problems weighted by severity — fewer is better. */
async function reputationAccuracy(projectId: string, period: Period): Promise<ComponentResult> {
  const rows = await sql`
    select severity, count(*) as n from accuracy_findings
    where project_id = ${projectId} and status = 'open'
      and created_at < ${period.end}::date + 1
    group by severity
  `;
  const [checked] = await sql`
    select count(*) as n from accuracy_findings where project_id = ${projectId}
  `;
  if (Number(checked?.n ?? 0) === 0) {
    return component("reputation_accuracy", null, "accuracy monitoring has not run for this client");
  }
  const counts = Object.fromEntries(rows.map((r) => [r.severity as string, Number(r.n)]));
  const weighted =
    (counts.high ?? 0) * 1 + (counts.medium ?? 0) * 0.5 + (counts.low ?? 0) * 0.2;
  const score = Math.max(0, 1 - weighted / 5); // five weighted problems ⇒ 0
  return component(
    "reputation_accuracy",
    Math.round(score * 1000) / 1000,
    weighted === 0
      ? "no open factual problems"
      : `${counts.high ?? 0} high / ${counts.medium ?? 0} medium / ${counts.low ?? 0} low open`,
    counts
  );
}

/** Tasks moved to done vs approved, this period. */
async function executionVelocity(projectId: string, period: Period): Promise<ComponentResult> {
  const [row] = await sql`
    select
      count(*) filter (where status = 'done') as done,
      count(*) filter (where status in ('approved','in_progress','done')) as active
    from tasks
    where project_id = ${projectId}
      and updated_at >= ${period.start}::date
      and updated_at < ${period.end}::date + 1
  `;
  const active = Number(row?.active ?? 0);
  if (active === 0) {
    return component("execution_velocity", null, "no approved work in this period");
  }
  const done = Number(row?.done ?? 0);
  return component(
    "execution_velocity",
    Math.round((done / active) * 1000) / 1000,
    `${done} of ${active} approved items completed`,
    { done, active }
  );
}

/** How fast approvals get decided — the operator's own responsiveness. */
async function approvalVelocity(projectId: string, period: Period): Promise<ComponentResult> {
  const [row] = await sql`
    select
      count(*) as total,
      count(*) filter (where decision is not null) as decided,
      avg(extract(epoch from (decided_at - requested_at)) / 3600)
        filter (where decision is not null) as avg_hours
    from workflow_approvals
    where project_id = ${projectId}
      and requested_at >= ${period.start}::date
      and requested_at < ${period.end}::date + 1
  `;
  const total = Number(row?.total ?? 0);
  if (total === 0) {
    return component("approval_velocity", null, "no approvals requested in this period");
  }
  const avgHours = row?.avgHours === null ? null : Number(row?.avgHours);
  // 24h ⇒ 1.0, 72h ⇒ ~0.5, 168h ⇒ ~0
  const score =
    avgHours === null ? 0 : Math.max(0, Math.min(1, 1 - Math.max(0, avgHours - 24) / 144));
  return component(
    "approval_velocity",
    Math.round(score * 1000) / 1000,
    avgHours === null
      ? `${total} approval(s) requested, none decided yet`
      : `median-ish ${avgHours.toFixed(1)}h to decide ${row?.decided} of ${total}`,
    { total, decided: Number(row?.decided ?? 0), avgHours }
  );
}

/** Share of completed actions that have an after-measurement. */
async function attributionCompleteness(projectId: string, period: Period): Promise<ComponentResult> {
  const [row] = await sql`
    select count(*) as total, count(*) filter (where measured_at is not null) as measured
    from action_outcomes
    where project_id = ${projectId} and created_at < ${period.end}::date + 1
  `;
  const total = Number(row?.total ?? 0);
  if (total === 0) {
    return component("attribution_completeness", null, "no actions recorded in the outcome graph");
  }
  const measured = Number(row?.measured ?? 0);
  return component(
    "attribution_completeness",
    Math.round((measured / total) * 1000) / 1000,
    `${measured} of ${total} actions have an after-measurement`,
    { total, measured }
  );
}

/** Outcomes that showed a positive signal. Honest about small samples. */
async function leadOutcomes(projectId: string, period: Period): Promise<ComponentResult> {
  const rows = await sql`
    select effectiveness, count(*) as n from action_outcomes
    where project_id = ${projectId} and measured_at is not null
      and measured_at < ${period.end}::date + 1
    group by effectiveness
  `;
  const total = rows.reduce((sum, r) => sum + Number(r.n), 0);
  if (total === 0) {
    return component("lead_outcomes", null, "no measured outcomes yet");
  }
  const counts = Object.fromEntries(rows.map((r) => [r.effectiveness as string, Number(r.n)]));
  const positive = counts.positive_signal ?? 0;
  return component(
    "lead_outcomes",
    Math.round((positive / total) * 1000) / 1000,
    `${positive} of ${total} measured actions showed a positive signal (association, not cause)`,
    counts
  );
}

/** Failed jobs and failed runs are the integration signal we actually have. */
async function integrationHealth(projectId: string, period: Period): Promise<ComponentResult> {
  const [row] = await sql`
    select
      count(*) filter (where status = 'failed') as failed,
      count(*) as total
    from runs
    where project_id = ${projectId}
      and started_at >= ${period.start}::date
      and started_at < ${period.end}::date + 1
  `;
  const total = Number(row?.total ?? 0);
  if (total === 0) {
    return component("integration_health", null, "no runs in this period");
  }
  const failed = Number(row?.failed ?? 0);
  return component(
    "integration_health",
    Math.round((1 - failed / total) * 1000) / 1000,
    `${failed} of ${total} runs failed`,
    { failed, total }
  );
}

/** Is the client's configured measurement actually being used? */
async function scopeUtilisation(projectId: string, period: Period): Promise<ComponentResult> {
  const [row] = await sql`
    select
      (select count(*) from prompts pr
        join prompt_sets ps on ps.id = pr.prompt_set_id
        where ps.project_id = ${projectId}) as prompts,
      (select count(*) from runs
        where project_id = ${projectId}
          and started_at >= ${period.start}::date
          and started_at < ${period.end}::date + 1) as runs
  `;
  const prompts = Number(row?.prompts ?? 0);
  if (prompts === 0) {
    return component("scope_utilisation", null, "no prompts configured for this client");
  }
  const runs = Number(row?.runs ?? 0);
  // One run in the period is the expectation for a weekly cadence.
  return component(
    "scope_utilisation",
    runs === 0 ? 0 : 1,
    runs === 0 ? "no measurement ran in this period" : `${runs} run(s) against ${prompts} prompts`,
    { prompts, runs }
  );
}

/** Client-side engagement: approvals decided, claims supplied, validation runs. */
async function clientEngagement(projectId: string, period: Period): Promise<ComponentResult> {
  // As of the period end, so a snapshot recomputed later reproduces the same
  // number rather than drifting with today's data.
  const [row] = await sql`
    select
      (select count(*) from claims
        where project_id = ${projectId} and status = 'approved'
          and created_at < ${period.end}::date + 1) as claims,
      (select count(*) from client_validation_runs
        where project_id = ${projectId}
          and created_at < ${period.end}::date + 1) as validations
  `;
  const claims = Number(row?.claims ?? 0);
  const validations = Number(row?.validations ?? 0);
  if (claims === 0 && validations === 0) {
    return component(
      "client_engagement",
      null,
      "the client has supplied no approved claims and run no validation"
    );
  }
  // Ten approved claims is a well-supplied knowledge base.
  const score = Math.min(1, claims / 10 + (validations > 0 ? 0.2 : 0));
  return component(
    "client_engagement",
    Math.round(Math.min(1, score) * 1000) / 1000,
    `${claims} approved claim(s), ${validations} client validation run(s)`,
    { claims, validations }
  );
}

/** Inverted risk: 1.0 means low renewal risk. */
async function renewalRisk(projectId: string, period: Period): Promise<ComponentResult> {
  const [row] = await sql`
    select
      (select count(*) from workflow_exceptions
        where project_id = ${projectId} and status in ('open','acknowledged')
          and severity in ('high','critical')) as severe_exceptions,
      (select count(*) from reports
        where project_id = ${projectId} and status = 'published'
          and created_at >= ${period.end}::date - interval '60 days') as recent_reports,
      (select max(started_at) from runs where project_id = ${projectId}) as last_run
  `;
  const severe = Number(row?.severeExceptions ?? 0);
  const reports = Number(row?.recentReports ?? 0);
  const lastRun = row?.lastRun as Date | null;
  if (!lastRun) {
    return component("renewal_risk", null, "the client has never been measured");
  }
  const daysSinceRun = Math.floor((Date.now() - lastRun.getTime()) / 86_400_000);
  let score = 1;
  const reasons: string[] = [];
  if (severe > 0) {
    score -= Math.min(0.4, severe * 0.15);
    reasons.push(`${severe} severe open exception(s)`);
  }
  if (reports === 0) {
    score -= 0.3;
    reasons.push("no published report in 60 days");
  }
  if (daysSinceRun > 14) {
    score -= 0.3;
    reasons.push(`${daysSinceRun}d since the last measurement`);
  }
  return component(
    "renewal_risk",
    Math.round(Math.max(0, score) * 1000) / 1000,
    reasons.length === 0 ? "no renewal-risk signals" : reasons.join("; "),
    { severe, reports, daysSinceRun }
  );
}
