/**
 * Snapshot builder (spec 006): assembles the fully self-contained report
 * body for a period. Current = latest scored run in the period; previous =
 * latest scored run before the period with the same frozen prompt-set
 * version and scoring version (docs/06 forbids cross-version comparison).
 */
import { sql } from "@/db/client";
import { getSubjectCompany } from "@/db/companies";
import { ClassifiedError } from "@/lib/errors";
import { SCORING_VERSION } from "@/lib/constants";
import { changeVerdict, type ProviderDelta } from "@/lib/reports/deltas";
import { draftNarrative } from "@/lib/reports/narrative";
import {
  buildProgram,
  buildCategoryOwnership,
} from "@/lib/reports/program";
import type {
  ReportBody,
  ReportKind,
  SnapshotScore,
  SnapshotDelta,
  SnapshotExcerpt,
} from "@/lib/reports/types";

async function scoresForRun(
  runId: string,
  subjectId: string | null
): Promise<SnapshotScore[]> {
  const rows = await sql`
    select s.id as score_id, s.company_id, c.name as company_name,
      s.metric, s.provider, s.value, s.sample_size, s.scoring_version
    from scores s join companies c on c.id = s.company_id
    where s.run_id = ${runId} and s.scoring_version = ${SCORING_VERSION}
  `;
  return rows.map((r) => ({
    scoreId: r.scoreId as string,
    companyId: r.companyId as string,
    companyName: r.companyName as string,
    isSelf: (r.companyId as string) === subjectId,
    metric: r.metric as string,
    provider: r.provider as string,
    value: Number(r.value),
    sampleSize: r.sampleSize as number,
    scoringVersion: r.scoringVersion as string,
  }));
}

export async function buildSnapshot(
  projectId: string,
  periodStart: string,
  periodEnd: string,
  kind: ReportKind = "monthly"
): Promise<Omit<ReportBody, "narrative"> & { narrative: ReportBody["narrative"] }> {
  const runs = await sql`
    select r.id, r.label, r.started_at, r.prompt_set_version_id
    from runs r
    where r.project_id = ${projectId}
      -- Period bounds are UTC-anchored explicitly: a bare ::date cast would
      -- compare in the SESSION timezone, so a run started after UTC midnight
      -- but before local midnight would fall outside its own period (bit the
      -- weekly cycle every Sunday evening in negative-offset zones).
      and r.started_at >= (${periodStart} || ' 00:00:00+00')::timestamptz
      and r.started_at < (((${periodEnd}::date + 1)::text) || ' 00:00:00+00')::timestamptz
      and r.status in ('completed', 'partial')
    order by r.started_at asc
  `;
  if (runs.length === 0) {
    throw new ClassifiedError(
      "validation",
      "The period contains no completed runs — nothing to report on."
    );
  }

  const scoredRuns = [];
  for (const run of runs) {
    const [hasScores] = await sql`
      select 1 from scores where run_id = ${run.id} limit 1
    `;
    if (hasScores) scoredRuns.push(run);
  }
  const current = scoredRuns[scoredRuns.length - 1];
  if (!current) {
    throw new ClassifiedError(
      "conflict",
      "No run in the period has scores yet (parsing or review may be pending)."
    );
  }

  // Previous comparable run: before the period, same frozen version, scored
  const [previous] = await sql`
    select r.id from runs r
    where r.project_id = ${projectId}
      and r.started_at < (${periodStart} || ' 00:00:00+00')::timestamptz
      and r.prompt_set_version_id = ${current.promptSetVersionId}
      and exists (select 1 from scores s where s.run_id = r.id
        and s.scoring_version = ${SCORING_VERSION})
    order by r.started_at desc limit 1
  `;

  const subject = await getSubjectCompany(projectId);
  const subjectId = subject?.id ?? null;
  const scores = await scoresForRun(current.id as string, subjectId);
  const previousScores = previous
    ? await scoresForRun(previous.id as string, subjectId)
    : [];

  const deltas: SnapshotDelta[] = [];
  if (previous) {
    const key = (s: SnapshotScore) => `${s.companyId}|${s.metric}|${s.provider}`;
    const prevByKey = new Map(previousScores.map((s) => [key(s), s]));
    for (const score of scores.filter((s) => s.provider === "all")) {
      const prev = prevByKey.get(key(score));
      if (!prev) continue;
      const perProvider: ProviderDelta[] = scores
        .filter(
          (s) =>
            s.companyId === score.companyId &&
            s.metric === score.metric &&
            s.provider !== "all"
        )
        .flatMap((s) => {
          const p = prevByKey.get(key(s));
          return p
            ? [{
                provider: s.provider,
                current: s.value,
                previous: p.value,
                nCurrent: s.sampleSize,
                nPrevious: p.sampleSize,
              }]
            : [];
        });
      deltas.push({
        companyId: score.companyId,
        companyName: score.companyName,
        isSelf: score.isSelf,
        metric: score.metric,
        current: score.value,
        previous: prev.value,
        delta: score.value - prev.value,
        verdict: changeVerdict(
          score.metric,
          {
            current: score.value,
            previous: prev.value,
            nCurrent: score.sampleSize,
            nPrevious: prev.sampleSize,
          },
          perProvider
        ),
      });
    }
  }

  // Notable excerpts: current-revision mentions with excerpts, self first
  const excerptRows = await sql`
    select distinct on (m.company_id, m.response_id)
      m.response_id, m.company_id, c.name as company_name, r.provider,
      runs.label as run_label, m.excerpt, m.recommended, m.confidence
    from mentions m
    join companies c on c.id = m.company_id
    join responses r on r.id = m.response_id
    join runs on runs.id = r.run_id
    where runs.id = ${current.id} and m.mentioned and m.excerpt is not null
      and not exists (
        select 1 from mentions newer
        where newer.response_id = m.response_id
          and newer.company_id = m.company_id and newer.revision > m.revision
      )
    order by m.company_id, m.response_id, m.revision desc
  `;
  const excerpts: SnapshotExcerpt[] = excerptRows
    .sort((a, b) => {
      const aSelf = (a.companyId as string) === subjectId;
      const bSelf = (b.companyId as string) === subjectId;
      return aSelf === bSelf
        ? Number(b.confidence) - Number(a.confidence)
        : aSelf
          ? -1
          : 1;
    })
    .slice(0, 6)
    .map((r) => ({
      responseId: r.responseId as string,
      companyName: r.companyName as string,
      provider: r.provider as string,
      runLabel: r.runLabel as string,
      excerpt: r.excerpt as string,
      recommended: r.recommended as boolean,
    }));

  const runIds = runs.map((r) => r.id as string);
  const [coverageRow] = await sql`
    select
      count(*) filter (where error is null)::int as captured,
      count(distinct (prompt_id, provider, model, repetition))
        filter (where error is not null)::int as failed,
      count(*) filter (where refusal)::int as refusals
    from responses where run_id = any(${runIds})
  `;
  const [pendingRow] = await sql`
    select count(*)::int as n
    from mentions m join responses r on r.id = m.response_id
    where r.run_id = any(${runIds}) and m.needs_review
      and not exists (
        select 1 from mentions newer
        where newer.response_id = m.response_id
          and newer.company_id = m.company_id and newer.revision > m.revision
      )
  `;

  const [now] = await sql`select now() as ts`;
  // Whole-platform activity + ownership map (spec 016)
  const [program, categoryOwnership] = await Promise.all([
    buildProgram({ projectId, periodStart, periodEnd }),
    buildCategoryOwnership({
      projectId,
      runId: current.id as string,
      promptSetVersionId: current.promptSetVersionId as string,
    }),
  ]);

  const base: Omit<ReportBody, "narrative"> = {
    kind,
    program,
    categoryOwnership,
    scoringVersion: SCORING_VERSION,
    generatedAt: (now?.ts as Date).toISOString(),
    runs: runs.map((r) => ({
      id: r.id as string,
      label: r.label as string,
      startedAt: (r.startedAt as Date).toISOString(),
    })),
    currentRunId: current.id as string,
    previousRunId: (previous?.id as string) ?? null,
    comparable: Boolean(previous),
    comparabilityNote: previous
      ? ""
      : "No comparable prior run exists (same frozen prompt set and scoring version) — this report is a new baseline with no deltas.",
    scores,
    deltas,
    excerpts,
    coverage: {
      runCount: runs.length,
      capturedCells: (coverageRow?.captured as number) ?? 0,
      failedCells: (coverageRow?.failed as number) ?? 0,
      refusals: (coverageRow?.refusals as number) ?? 0,
      pendingReview: (pendingRow?.n as number) ?? 0,
    },
  };

  return { ...base, narrative: draftNarrative(base) };
  // Narrative shape varies by cadence — see lib/reports/narrative.ts
}
