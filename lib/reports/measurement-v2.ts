/**
 * Report v2 measurement section (spec 151 C7). Data only — the existing
 * report draft/publish flow and its human sign-off are unchanged.
 *
 *  - per-model estimates with 95% intervals (never a blended provider row);
 *  - change since the previous comparable run, per model, as a paired
 *    prompt-level difference with an interval (or "not comparable");
 *  - the minimum detectable effect of the current panel;
 *  - intervention experiment verdicts, including nulls and negatives;
 *  - client-reported outcomes for the period, labelled by provenance;
 *  - next actions: APPROVED opportunities only — an unreviewed proposal
 *    never enters a report body (review finding L1).
 */
import { sql } from "@/db/client";
import { SCORING_VERSION } from "@/lib/constants";
import { estimatesForRun } from "@/db/measurement";
import { minimumDetectableEffect, pairClusters, pairedDifference, seedFromKey, type Cluster } from "@/lib/stats";
import { evaluatePlanUnchecked, wavesForRuns } from "@/lib/experiments/service";

export interface ReportEstimate {
  companyId: string;
  companyName: string;
  isSubject: boolean;
  metric: string;
  provider: string;
  model: string;
  rate: number | null;
  low: number | null;
  high: number | null;
  numerator: number;
  denominator: number;
  prompts: number;
}

export interface ReportChange {
  provider: string;
  model: string;
  metric: string;
  estimate: number | null;
  low: number | null;
  high: number | null;
  prompts: number;
  status: "measured" | "not_comparable" | "no_previous_run";
  note: string;
}

export interface MeasurementSection {
  version: "report-measurement-v2";
  estimates: ReportEstimate[];
  changes: ReportChange[];
  mde: { metric: string; model: string; value: number | null; prompts: number; repetitions: number } | null;
  experiments: { planId: string; interventionType: string; verdict: string; evidenceTier: number; explanation: string }[];
  outcomes: { periodStart: string; periodEnd: string; provenance: string; qualifiedLeads: number | null; aiDiscoveryMentions: number | null; closedTransactions: number | null }[];
  nextActions: { title: string; recommendedAction: string; status: string; priorityBand: string }[];
  limitations: string[];
}

const PRIMARY = "recommendation_rate";

function clustersByPrompt(wave: Awaited<ReturnType<typeof wavesForRuns>>[number], companyId: string): Map<string, Cluster> {
  const out = new Map<string, Cluster>();
  for (const a of wave.answers) {
    const c = out.get(a.promptId) ?? { k: 0, n: 0 };
    c.n += 1;
    if (wave.hits.has(`${a.responseId}|${companyId}`)) c.k += 1;
    out.set(a.promptId, c);
  }
  return out;
}

export async function buildMeasurementSection(input: {
  projectId: string;
  currentRunId: string;
  previousRunId: string | null;
  periodStart: string;
  periodEnd: string;
}): Promise<MeasurementSection> {
  const [project] = await sql`select subject_company_id from projects where id = ${input.projectId}`;
  const subjectId = (project?.subjectCompanyId as string | null) ?? null;
  const raw = await estimatesForRun(input.currentRunId, SCORING_VERSION);
  const names = raw.length
    ? await sql`select id, name from companies where id = any(${[...new Set(raw.map((e) => e.companyId))]})`
    : [];
  const nameOf = new Map(names.map((n) => [n.id as string, n.name as string]));
  const estimates: ReportEstimate[] = raw
    .filter((e) => e.metric === PRIMARY || e.metric === "mention_rate")
    .map((e) => ({
      companyId: e.companyId,
      companyName: nameOf.get(e.companyId) ?? "",
      isSubject: e.companyId === subjectId,
      metric: e.metric,
      provider: e.provider,
      model: e.model,
      rate: e.rate,
      low: e.clusteredLow,
      high: e.clusteredHigh,
      numerator: e.numerator,
      denominator: e.denominator,
      prompts: e.distinctPrompts,
    }));

  const changes: ReportChange[] = [];
  if (subjectId) {
    const current = await wavesForRuns([input.currentRunId], PRIMARY, [subjectId]);
    const previous = input.previousRunId ? await wavesForRuns([input.previousRunId], PRIMARY, [subjectId]) : [];
    for (const wave of current) {
      const [provider, model] = wave.instrumentKey.split("|") as [string, string];
      const prior = previous.find((w) => w.instrumentKey === wave.instrumentKey);
      if (!input.previousRunId) {
        changes.push({ provider, model, metric: PRIMARY, estimate: null, low: null, high: null, prompts: 0, status: "no_previous_run", note: "First measurement: this is the baseline." });
        continue;
      }
      const servedChanged = prior && prior.servedModels.length > 0 && wave.servedModels.some((m) => !prior.servedModels.includes(m));
      if (!prior || servedChanged) {
        changes.push({
          provider, model, metric: PRIMARY, estimate: null, low: null, high: null, prompts: 0, status: "not_comparable",
          note: !prior ? "This model was not measured in the previous run." : "The provider served a different model version; the runs are not comparable.",
        });
        continue;
      }
      const pairs = pairClusters(clustersByPrompt(prior, subjectId), clustersByPrompt(wave, subjectId));
      const diff = pairedDifference(pairs, seedFromKey(`${input.previousRunId}|${input.currentRunId}|${wave.instrumentKey}`));
      changes.push({
        provider, model, metric: PRIMARY,
        estimate: diff.estimate, low: diff.interval?.[0] ?? null, high: diff.interval?.[1] ?? null, prompts: diff.prompts,
        status: "measured",
        note: diff.interval === null ? "Too few shared prompts for an interval." : "Paired by prompt; an interval that includes zero means no detectable change.",
      });
    }
  }

  const subjectPrimary = raw.find((e) => e.companyId === subjectId && e.metric === PRIMARY);
  const subjectMention = raw.find((e) => e.companyId === subjectId && e.metric === "mention_rate" && e.model === subjectPrimary?.model);
  const reps = subjectPrimary && subjectPrimary.distinctPrompts > 0 ? subjectPrimary.denominator / subjectPrimary.distinctPrompts : 0;
  const mde = subjectPrimary
    ? {
        metric: PRIMARY,
        model: subjectPrimary.model,
        value: minimumDetectableEffect({
          baselineRate: subjectPrimary.rate ?? 0,
          prompts: subjectPrimary.distinctPrompts,
          repetitions: Math.max(1, Math.round(reps)),
          icc: subjectMention?.icc ?? 0,
        }),
        prompts: subjectPrimary.distinctPrompts,
        repetitions: Math.round(reps),
      }
    : null;

  const plans = await sql`
    select id, intervention_type from intervention_plans
    where project_id = ${input.projectId} and status = 'approved' and intervention_id is not null
  `;
  const experiments = [];
  for (const p of plans) {
    const { evaluation } = await evaluatePlanUnchecked(p.id as string);
    experiments.push({
      planId: p.id as string,
      interventionType: p.interventionType as string,
      verdict: evaluation.verdict,
      evidenceTier: evaluation.evidenceTier,
      explanation: evaluation.explanation,
    });
  }

  const outcomes = await sql`
    select period_start::text, period_end::text, provenance, qualified_leads, ai_discovery_mentions, closed_transactions
    from client_outcomes o
    where project_id = ${input.projectId} and period_end >= ${input.periodStart}::date and period_start <= ${input.periodEnd}::date
      and not exists (select 1 from client_outcomes n where n.supersedes = o.id)
    order by period_start
  `;
  const next = await sql`
    select title, recommended_action, status, priority_band from opportunities
    where project_id = ${input.projectId} and status in ('approved', 'in_progress')
    order by priority_score desc limit 5
  `;

  return {
    version: "report-measurement-v2",
    estimates,
    changes,
    mde,
    experiments,
    outcomes: outcomes.map((o) => ({
      periodStart: o.periodStart as string,
      periodEnd: o.periodEnd as string,
      provenance: o.provenance as string,
      qualifiedLeads: (o.qualifiedLeads as number | null) ?? null,
      aiDiscoveryMentions: (o.aiDiscoveryMentions as number | null) ?? null,
      closedTransactions: (o.closedTransactions as number | null) ?? null,
    })),
    nextActions: next.map((n) => ({
      title: n.title as string,
      recommendedAction: n.recommendedAction as string,
      status: n.status as string,
      priorityBand: n.priorityBand as string,
    })),
    limitations: [
      "Measured through the AI providers' APIs with web search, not the consumer apps; answers are not personalized and no location is sent.",
      "Rates are shares of sampled answers. The 95% interval is statistical uncertainty over prompts, not the classifier's confidence.",
      "Client-reported outcomes are shown next to visibility as correlation only.",
      "The detectable-change figure is a planning approximation (two independent waves, mention-rate clustering); a controlled comparison needs roughly 1.4× larger effects.",
    ],
  };
}
