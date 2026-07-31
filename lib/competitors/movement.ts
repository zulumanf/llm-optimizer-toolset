/**
 * Competitor movement (spec 030). Derived, never stored: like the rest of
 * the attention feed, an overtake exists only while the latest comparable
 * pair of runs shows it. Comparisons happen ONLY between the latest two
 * scored runs on the same frozen prompt-set version and scoring version —
 * anything else is a changed ruler, not movement.
 *
 * The noise rules are reports' rules (lib/reports/deltas): a flip inside
 * sampling noise is a coin toss, not an overtake, so every event requires a
 * `notable` verdict on at least one side of the flip.
 */
import { sql } from "@/db/client";
import { getSubjectCompany } from "@/db/companies";
import { changeVerdict, type ProviderDelta } from "@/lib/reports/deltas";

export const MOVEMENT_METRICS = ["mention_rate", "recommendation_rate"] as const;
export type MovementMetric = (typeof MOVEMENT_METRICS)[number];

export interface MetricSeries {
  aggregate: {
    current: number;
    previous: number;
    nCurrent: number;
    nPrevious: number;
  };
  perProvider: ProviderDelta[];
}

export interface CompanySeries {
  companyId: string;
  name: string;
  metrics: Partial<Record<MovementMetric, MetricSeries>>;
}

export interface MovementEvent {
  kind: "competitor_overtake" | "visibility_drop";
  metric: MovementMetric;
  competitorId?: string;
  competitorName?: string;
  /** The moving party's aggregate — subject for drops, competitor for
   * overtakes — so event consumers get numbers, not just prose. */
  previous: number;
  current: number;
  sampleSize: number;
  /** Stamped by movementForProject from the two runs' start dates;
   * absent when events come straight from detectMovement fixtures. */
  periodStart?: string;
  periodEnd?: string;
  /** The numbers that justify the event — subject then competitor. */
  detail: string;
}

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

/** Pure. `subject` and each competitor carry the same two-run window. */
export function detectMovement(
  subject: CompanySeries,
  competitors: CompanySeries[]
): MovementEvent[] {
  const events: MovementEvent[] = [];

  for (const metric of MOVEMENT_METRICS) {
    const s = subject.metrics[metric];
    if (!s) continue;
    const subjectVerdict = changeVerdict(metric, s.aggregate, s.perProvider);
    const subjectDelta = s.aggregate.current - s.aggregate.previous;

    if (subjectVerdict === "notable" && subjectDelta < 0) {
      events.push({
        kind: "visibility_drop",
        metric,
        previous: s.aggregate.previous,
        current: s.aggregate.current,
        sampleSize: s.aggregate.nCurrent,
        detail: `${subject.name} ${metric.replace(/_/g, " ")} fell ${pct(
          s.aggregate.previous
        )} → ${pct(s.aggregate.current)} (n=${s.aggregate.nCurrent}/side)`,
      });
    }

    for (const competitor of competitors) {
      const c = competitor.metrics[metric];
      if (!c) continue;
      const flipped =
        s.aggregate.previous >= c.aggregate.previous &&
        c.aggregate.current > s.aggregate.current;
      if (!flipped) continue;
      const competitorVerdict = changeVerdict(metric, c.aggregate, c.perProvider);
      const competitorDelta = c.aggregate.current - c.aggregate.previous;
      // A flip is an overtake only when at least one side moved notably:
      // the competitor rose, or the subject fell, beyond noise.
      const justified =
        (competitorVerdict === "notable" && competitorDelta > 0) ||
        (subjectVerdict === "notable" && subjectDelta < 0);
      if (!justified) continue;
      events.push({
        kind: "competitor_overtake",
        metric,
        competitorId: competitor.companyId,
        competitorName: competitor.name,
        previous: c.aggregate.previous,
        current: c.aggregate.current,
        sampleSize: c.aggregate.nCurrent,
        detail: `${competitor.name} overtook ${subject.name} on ${metric.replace(
          /_/g,
          " "
        )}: ${pct(c.aggregate.previous)} → ${pct(c.aggregate.current)} vs ${pct(
          s.aggregate.previous
        )} → ${pct(s.aggregate.current)}`,
      });
    }
  }
  return events;
}

interface ScoreRow {
  companyId: string;
  metric: string;
  provider: string;
  value: number;
  sampleSize: number;
}

function buildSeries(
  companyId: string,
  name: string,
  current: ScoreRow[],
  previous: ScoreRow[]
): CompanySeries {
  const series: CompanySeries = { companyId, name, metrics: {} };
  for (const metric of MOVEMENT_METRICS) {
    const curAll = current.find(
      (r) => r.companyId === companyId && r.metric === metric && r.provider === "all"
    );
    const prevAll = previous.find(
      (r) => r.companyId === companyId && r.metric === metric && r.provider === "all"
    );
    if (!curAll || !prevAll) continue;
    const providers = new Set(
      current
        .filter(
          (r) => r.companyId === companyId && r.metric === metric && r.provider !== "all"
        )
        .map((r) => r.provider)
    );
    const perProvider: ProviderDelta[] = [];
    for (const provider of providers) {
      const cur = current.find(
        (r) => r.companyId === companyId && r.metric === metric && r.provider === provider
      );
      const prev = previous.find(
        (r) => r.companyId === companyId && r.metric === metric && r.provider === provider
      );
      if (!cur || !prev) continue;
      perProvider.push({
        provider,
        current: Number(cur.value),
        previous: Number(prev.value),
        nCurrent: Number(cur.sampleSize),
        nPrevious: Number(prev.sampleSize),
      });
    }
    series.metrics[metric] = {
      aggregate: {
        current: Number(curAll.value),
        previous: Number(prevAll.value),
        nCurrent: Number(curAll.sampleSize),
        nPrevious: Number(prevAll.sampleSize),
      },
      perProvider,
    };
  }
  return series;
}

/** Movement events for one project, or [] when no comparable run pair
 * exists (fewer than two scored runs, version mismatch, no subject). */
export async function movementForProject(
  projectId: string
): Promise<MovementEvent[]> {
  const subject = await getSubjectCompany(projectId);
  if (!subject) return [];

  const [latest] = await sql`
    select r.id, r.prompt_set_version_id, r.started_at,
      (select s.scoring_version from scores s where s.run_id = r.id limit 1)
        as scoring_version
    from runs r
    where r.project_id = ${projectId}
      and exists (select 1 from scores s where s.run_id = r.id)
    order by r.started_at desc limit 1
  `;
  if (!latest) return [];

  const [previous] = await sql`
    select r.id, r.started_at from runs r
    where r.project_id = ${projectId}
      and r.id != ${latest.id}
      and r.prompt_set_version_id = ${latest.promptSetVersionId}
      and exists (select 1 from scores s
        where s.run_id = r.id and s.scoring_version = ${latest.scoringVersion})
    order by r.started_at desc limit 1
  `;
  if (!previous) return [];

  const loadScores = (runId: string) => sql<ScoreRow[]>`
    select company_id, metric, provider, value, sample_size
    from scores
    where run_id = ${runId} and scoring_version = ${latest.scoringVersion}
      and metric = any(${[...MOVEMENT_METRICS]})
  `;
  const [currentRows, previousRows] = await Promise.all([
    loadScores(latest.id as string),
    loadScores(previous.id as string),
  ]);

  const competitors = await sql`
    select c.company_id, co.name from competitors c
    join companies co on co.id = c.company_id
    where c.project_id = ${projectId} and c.archived_at is null
  `;

  const subjectSeries = buildSeries(
    subject.id,
    subject.name,
    currentRows,
    previousRows
  );
  const competitorSeries = competitors.map((c) =>
    buildSeries(c.companyId as string, c.name as string, currentRows, previousRows)
  );
  const periodStart = (previous.startedAt as Date).toISOString().slice(0, 10);
  const periodEnd = (latest.startedAt as Date).toISOString().slice(0, 10);
  return detectMovement(subjectSeries, competitorSeries).map((event) => ({
    ...event,
    periodStart,
    periodEnd,
  }));
}
