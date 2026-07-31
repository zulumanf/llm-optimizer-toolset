import { portalOverview } from "@/lib/portal/service";
import {
  AuthorityTrendChart,
  type TrendDatum,
} from "@/components/charts/authority-trend";
import { formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";

const METRIC_LABELS: Record<string, string> = {
  mention_rate: "Mentioned in answers",
  recommendation_rate: "Actively recommended",
  first_position_rate: "Recommended first",
};

export default async function PortalOverviewPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const overview = await portalOverview(projectId);

  if (overview.headlines.length === 0) {
    return (
      <p className="rounded-md border border-dashed p-8 text-sm text-muted-foreground">
        Measurement is being set up — numbers appear here after the first
        scored benchmark run.
      </p>
    );
  }

  return (
    <div className="space-y-8">
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {overview.headlines.map((h) => (
          <div key={h.metric} className="rounded-lg border p-4">
            <p className="text-sm text-muted-foreground">
              {METRIC_LABELS[h.metric] ?? h.metric}
            </p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              {(h.value * 100).toFixed(0)}%
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              of {h.sampleSize} AI answers · methodology {h.scoringVersion}
            </p>
          </div>
        ))}
      </section>

      {overview.trend.length > 1 &&
        (() => {
          // Same pivot the internal dashboard uses (one datum per run).
          const byRun = new Map<string, TrendDatum>();
          for (const point of overview.trend) {
            if (!byRun.has(point.runId)) {
              byRun.set(point.runId, {
                runLabel: point.runLabel,
                startedAt: point.startedAt.toISOString(),
                scoringVersion: point.scoringVersion,
                promptSetVersionId: point.promptSetVersionId,
                values: {},
              });
            }
            byRun.get(point.runId)!.values[point.provider] = Number(point.value);
          }
          const providers = [
            ...new Set(
              overview.trend.map((p) => p.provider).filter((p) => p !== "all")
            ),
          ];
          return (
            <section>
              <h2 className="mb-2 text-lg font-medium">Authority over time</h2>
              <AuthorityTrendChart data={[...byRun.values()]} providers={providers} />
            </section>
          );
        })()}

      <p className="text-xs text-muted-foreground">
        Observed measurements from repeated AI-assistant runs
        {overview.lastMeasuredAt
          ? `; last measured ${formatDate(overview.lastMeasuredAt)}`
          : ""}
        . Every number carries its sample size — a rate without one is not a
        measurement.
      </p>
    </div>
  );
}
