/**
 * Executive brief generation (spec 019, Parts 15-16).
 *
 * The design that makes this trustworthy: **deterministic code computes every
 * number and decides what is material; the agent only writes prose about
 * numbers it was handed.** The agent cannot query anything, cannot compute
 * anything, and every statement it produces carries a `kind` — fact,
 * calculation, interpretation, recommendation, correlation, causal, unknown —
 * which the executive reporting gate then checks.
 *
 * Weekly LLM output is volatile. A brief that reports every wobble trains the
 * operator to ignore it, so nothing below a materiality threshold is surfaced.
 */
import { sql, type TransactionSql } from "@/db/client";
import { executiveReportingGate, type ReportStatement } from "@/lib/workflow/gates";
import { SCORING_VERSION } from "@/lib/constants";

type Tx = TransactionSql | typeof sql;

export const BRIEF_METHODOLOGY_VERSION = "weekly-brief-v1.0";

/**
 * Materiality thresholds. A metric must move by at least this much before the
 * brief mentions it. Set from docs/06's change-detection discipline: below
 * these, week-to-week movement is provider noise.
 */
export const MATERIALITY = {
  /** Absolute change in a rate metric (0..1). */
  rateDelta: 0.05,
  /** New or lost recommendations, in count. */
  recommendationCount: 1,
  /** New citations, in count. */
  citationCount: 1,
} as const;

export interface BriefInput {
  projectId: string;
  periodStart: string;
  periodEnd: string;
}

export interface MetricDelta {
  metric: string;
  current: number;
  previous: number | null;
  delta: number | null;
  sampleSize: number;
  material: boolean;
  scoringVersion: string;
  evidenceIds: string[];
}

export interface BriefData {
  projectId: string;
  projectName: string;
  periodStart: string;
  periodEnd: string;
  periodComplete: boolean;
  deltas: MetricDelta[];
  materialDeltas: MetricDelta[];
  workCompleted: { title: string; at: string }[];
  workBlocked: { summary: string; kind: string }[];
  approvalsNeeded: { summary: string; requestedAt: string }[];
  newOpportunities: { finding: string; score: number }[];
  newFactualProblems: { id: string; quote: string; severity: string }[];
  integrationIssues: string[];
  sampleSizes: Record<string, number>;
}

/**
 * Gather everything the brief may talk about. Pure reads, one client, no
 * agent involvement — this is the factual substrate.
 */
export async function collectBriefData(input: BriefInput): Promise<BriefData> {
  const [project] = await sql`select name from projects where id = ${input.projectId}`;
  const projectName = (project?.name as string) ?? "Unknown client";

  // Latest scored run in the period, and the one before it, for deltas.
  const runs = await sql`
    select r.id, r.started_at, r.status
    from runs r
    where r.project_id = ${input.projectId}
      and r.started_at < ${input.periodEnd}::date + 1
      and exists (select 1 from scores s where s.run_id = r.id)
    order by r.started_at desc
    limit 2
  `;
  const currentRun = runs[0];
  const previousRun = runs[1];

  const deltas: MetricDelta[] = [];
  const sampleSizes: Record<string, number> = {};

  if (currentRun) {
    const rows = await sql`
      select s.id, s.metric, s.value, s.sample_size, s.scoring_version
      from scores s
      join projects p on p.id = ${input.projectId}
      where s.run_id = ${currentRun.id}
        and s.company_id = p.subject_company_id
        and s.provider = 'all'
    `;
    const previousByMetric = new Map<string, { value: number; id: string }>();
    if (previousRun) {
      const prevRows = await sql`
        select s.id, s.metric, s.value
        from scores s
        join projects p on p.id = ${input.projectId}
        where s.run_id = ${previousRun.id}
          and s.company_id = p.subject_company_id
          and s.provider = 'all'
      `;
      for (const row of prevRows) {
        previousByMetric.set(row.metric as string, {
          value: Number(row.value),
          id: row.id as string,
        });
      }
    }
    for (const row of rows) {
      const metric = row.metric as string;
      const current = Number(row.value);
      const prev = previousByMetric.get(metric) ?? null;
      const previous = prev?.value ?? null;
      const delta = previous === null ? null : current - previous;
      sampleSizes[metric] = Number(row.sampleSize);
      deltas.push({
        metric,
        current,
        previous,
        delta,
        sampleSize: Number(row.sampleSize),
        material: delta !== null && Math.abs(delta) >= MATERIALITY.rateDelta,
        scoringVersion: (row.scoringVersion as string) ?? SCORING_VERSION,
        // The score rows the statement is derived from — the gate refuses a
        // material statement with no evidence, and for a computed delta the
        // two score rows ARE the evidence. Leaving this empty made every
        // brief with material movement fail its own gate (C4).
        evidenceIds: prev ? [row.id as string, prev.id] : [row.id as string],
      });
    }
  }

  const completed = await sql`
    select title, updated_at from tasks
    where project_id = ${input.projectId} and status = 'done'
      and updated_at >= ${input.periodStart}::date and updated_at < ${input.periodEnd}::date + 1
    order by updated_at desc limit 20
  `;
  const blocked = await sql`
    select summary, kind from workflow_exceptions
    where project_id = ${input.projectId} and status in ('open','acknowledged')
    order by severity desc, created_at desc limit 20
  `;
  const approvals = await sql`
    select summary, requested_at from workflow_approvals
    where project_id = ${input.projectId} and decision is null
    order by requested_at asc limit 20
  `;
  const opportunities = await sql`
    select finding, opportunity_score from gap_findings
    where project_id = ${input.projectId} and status = 'open'
      and created_at >= ${input.periodStart}::date
    order by opportunity_score desc limit 10
  `;
  const problems = await sql`
    select id, quote, severity from accuracy_findings
    where project_id = ${input.projectId} and status = 'open'
      and created_at >= ${input.periodStart}::date
    order by severity, created_at desc limit 10
  `;
  const failures = await sql`
    select status_detail from runs
    where project_id = ${input.projectId} and status in ('failed','partial')
      and started_at >= ${input.periodStart}::date and started_at < ${input.periodEnd}::date + 1
  `;

  return {
    projectId: input.projectId,
    projectName,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    // A period without a completed measurement is incomplete, and the gate
    // will refuse the brief rather than reporting on half a week.
    periodComplete: Boolean(currentRun) && currentRun?.status === "completed",
    deltas,
    materialDeltas: deltas.filter((d) => d.material),
    workCompleted: completed.map((r) => ({
      title: r.title as string,
      at: (r.updatedAt as Date).toISOString().slice(0, 10),
    })),
    workBlocked: blocked.map((r) => ({
      summary: r.summary as string,
      kind: r.kind as string,
    })),
    approvalsNeeded: approvals.map((r) => ({
      summary: r.summary as string,
      requestedAt: (r.requestedAt as Date).toISOString().slice(0, 10),
    })),
    newOpportunities: opportunities.map((r) => ({
      finding: r.finding as string,
      score: Number(r.opportunityScore),
    })),
    newFactualProblems: problems.map((r) => ({
      id: r.id as string,
      quote: r.quote as string,
      severity: r.severity as string,
    })),
    integrationIssues: failures
      .map((r) => (r.statusDetail as string | null) ?? "")
      .filter(Boolean),
    sampleSizes,
  };
}

/**
 * Compose the brief deterministically. Every statement is generated from data
 * with its kind attached — no LLM is required for a correct brief, which is
 * why the workflow can run this at autonomy 3.
 */
export function composeBrief(data: BriefData): {
  statements: ReportStatement[];
  risks: string[];
  uncertainties: string[];
} {
  const statements: ReportStatement[] = [];

  if (data.materialDeltas.length === 0 && data.deltas.length > 0) {
    statements.push({
      text: `No metric moved by the ${(MATERIALITY.rateDelta * 100).toFixed(0)}pp materiality threshold this period. Weekly LLM output is volatile; a quiet week is a normal week.`,
      kind: "calculation",
      evidenceIds: [],
      material: false,
    });
  }
  for (const delta of data.materialDeltas) {
    const direction = (delta.delta ?? 0) > 0 ? "rose" : "fell";
    statements.push({
      text: `${delta.metric.replace(/_/g, " ")} ${direction} to ${(delta.current * 100).toFixed(1)}% from ${((delta.previous ?? 0) * 100).toFixed(1)}% (n=${delta.sampleSize}, scoring ${delta.scoringVersion}).`,
      kind: "calculation",
      evidenceIds: delta.evidenceIds,
      material: true,
    });
  }
  for (const problem of data.newFactualProblems) {
    statements.push({
      text: `A ${problem.severity}-severity factual problem is live in AI answers: "${problem.quote.slice(0, 160)}".`,
      kind: "fact",
      // The accuracy finding is the evidence: it carries the verbatim quote
      // and its response linkage.
      evidenceIds: [problem.id],
      material: true,
    });
  }
  for (const work of data.workCompleted) {
    statements.push({
      text: `Completed: ${work.title} (${work.at}).`,
      kind: "fact",
      evidenceIds: [],
      material: false,
    });
  }
  for (const blocked of data.workBlocked) {
    statements.push({
      text: `Blocked (${blocked.kind}): ${blocked.summary}`,
      kind: "fact",
      evidenceIds: [],
      material: false,
    });
  }
  for (const approval of data.approvalsNeeded) {
    statements.push({
      text: `Awaiting your decision since ${approval.requestedAt}: ${approval.summary}`,
      kind: "recommendation",
      evidenceIds: [],
      material: false,
      hasRationale: true,
    });
  }
  for (const opportunity of data.newOpportunities.slice(0, 3)) {
    statements.push({
      text: `Opportunity (score ${opportunity.score.toFixed(2)}): ${opportunity.finding}`,
      kind: "recommendation",
      evidenceIds: [],
      material: false,
      hasRationale: true,
    });
  }

  const risks: string[] = [];
  if (data.integrationIssues.length > 0) {
    risks.push(
      `${data.integrationIssues.length} run(s) failed or completed partially: ${data.integrationIssues.slice(0, 3).join("; ")}`
    );
  }
  if (data.workBlocked.length > 0) {
    risks.push(`${data.workBlocked.length} item(s) are blocked on a human decision.`);
  }

  const uncertainties: string[] = [];
  if (!data.periodComplete) {
    uncertainties.push("The measurement period is incomplete; figures may change.");
  }
  if (data.deltas.some((d) => d.previous === null)) {
    uncertainties.push("Some metrics have no prior measurement, so no trend is stated.");
  }
  if (data.deltas.length > 0) {
    const minSample = Math.min(...data.deltas.map((d) => d.sampleSize));
    if (minSample < 10) {
      uncertainties.push(
        `Smallest sample this period is n=${minSample}; treat single-week movement as indicative, not conclusive.`
      );
    }
  }

  return { statements, risks, uncertainties };
}

export interface BriefResult {
  briefId: string | null;
  gate: ReturnType<typeof executiveReportingGate>;
  statements: ReportStatement[];
  risks: string[];
  uncertainties: string[];
}

/**
 * Generate and persist the weekly brief, gated. A brief that fails the
 * executive reporting gate is NOT written — an ungated brief is exactly the
 * artifact that gets forwarded to a client and then has to be retracted.
 */
export async function generateWeeklyBrief(
  tx: Tx,
  input: BriefInput
): Promise<BriefResult> {
  return generateExecutiveBrief(tx, input, "weekly");
}

const BRIEF_HEADLINES: Record<string, (name: string, start: string) => string> = {
  weekly: (name, start) => `${name} — week of ${start}`,
  monthly: (name, start) => `${name} — month beginning ${start}`,
  quarterly: (name, start) => `${name} — quarter beginning ${start}`,
};

/**
 * Monthly and quarterly briefs (roadmap 3.4) are the SAME deterministic
 * composition over a longer window — the enum accepted them since
 * migration 019 with no generator, spec 019's recorded "Not built". Same
 * gate, same materiality, same one-draft-per-period uniqueness.
 */
export async function generateExecutiveBrief(
  tx: Tx,
  input: BriefInput,
  kind: "weekly" | "monthly" | "quarterly"
): Promise<BriefResult> {
  const data = await collectBriefData(input);
  const { statements, risks, uncertainties } = composeBrief(data);

  const gate = executiveReportingGate({
    periodComplete: data.periodComplete,
    sampleSizes: data.sampleSizes,
    statements,
    risksDisclosed: risks.length > 0 || data.workBlocked.length === 0,
    uncertaintyDisclosed: uncertainties.length > 0 || data.deltas.length > 0,
    causalStatementsHumanApproved: false,
  });

  if (gate.outcome !== "pass") {
    return { briefId: null, gate, statements, risks, uncertainties };
  }

  const [row] = await tx`
    insert into executive_briefs (
      project_id, kind, period_start, period_end, sections, materiality,
      evidence_ids, generated_by
    ) values (
      ${input.projectId}, ${kind}, ${input.periodStart}, ${input.periodEnd},
      ${tx.json({ headline: BRIEF_HEADLINES[kind]!(data.projectName, input.periodStart), statements, risks, uncertainties } as never)},
      ${tx.json({ ...MATERIALITY, methodologyVersion: BRIEF_METHODOLOGY_VERSION } as never)},
      ${[...new Set(statements.flatMap((s) => s.evidenceIds))]},
      'deterministic'
    )
    on conflict do nothing
    returning id
  `;
  return {
    briefId: (row?.id as string) ?? null,
    gate,
    statements,
    risks,
    uncertainties,
  };
}
