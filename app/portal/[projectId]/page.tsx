import Link from "next/link";
import {
  nextMondayIso,
  portalCompetitive,
  portalEngagement,
  portalOverview,
  portalWork,
} from "@/lib/portal/service";
import { PortalEngagementBlock } from "@/components/portal/engagement-block";
import { getCurrentUser } from "@/lib/auth";
import {
  AuthorityTrendChart,
  type TrendDatum,
} from "@/components/charts/authority-trend";
import { formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";

/**
 * The client overview (spec 085): answers the four questions a client logs
 * in with, in order — is it working (hero + delta since baseline); where
 * do I stand vs my rivals (ranked, named, sample-sized); what have you
 * done for me (latest work inline); when do I hear from you next (cadence
 * line + latest report). Trust furniture everywhere: every number carries
 * its sample size and date; absence says "not measured", never zero.
 */

const pct = (v: number): string => `${Math.round(v * 100)}%`;

export default async function PortalOverviewPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const user = await getCurrentUser();
  const [overview, rivals, work, engagement] = await Promise.all([
    portalOverview(user, projectId),
    portalCompetitive(user, projectId),
    portalWork(user, projectId),
    portalEngagement(user, projectId),
  ]);

  if (overview.headlines.length === 0) {
    // A retained client whose measurement lives in a frozen baseline package
    // (spec 131) sees their program even before a project-owned scored run.
    if (engagement) return <PortalEngagementBlock engagement={engagement} />;
    return (
      <p className="rounded-md border border-dashed p-8 text-sm text-muted-foreground">
        Measurement is being set up — numbers appear here after the first
        scored benchmark run.
      </p>
    );
  }

  const rec = overview.headlines.find((h) => h.metric === "recommendation_rate");
  const secondary = overview.headlines.filter(
    (h) => h.metric !== "recommendation_rate"
  );
  const SECONDARY_LABELS: Record<string, string> = {
    mention_rate: "Mentioned in answers",
    first_position_rate: "Recommended first",
  };
  const delta =
    rec && overview.baseline ? rec.value - overview.baseline.value : null;

  return (
    <div className="space-y-10">
      {engagement && <PortalEngagementBlock engagement={engagement} />}
      {/* 1. Is it working? */}
      {rec && (
        <section>
          <p className="text-sm text-muted-foreground">
            When buyers and sellers ask AI assistants who to work with, you are
          </p>
          <p className="mt-1 text-2xl font-semibold tracking-tight">
            recommended in{" "}
            <span className={rec.value === 0 ? "text-destructive" : undefined}>
              {pct(rec.value)}
            </span>{" "}
            of {rec.sampleSize} answers
          </p>
          {overview.baseline && delta !== null && (
            <p className="mt-1 text-sm text-muted-foreground">
              {delta > 0
                ? `up from ${pct(overview.baseline.value)} when measurement began (${formatDate(overview.baseline.at)})`
                : delta < 0
                  ? `down from ${pct(overview.baseline.value)} at baseline (${formatDate(overview.baseline.at)})`
                  : `unchanged from baseline (${formatDate(overview.baseline.at)})`}
            </p>
          )}
          <div className="mt-4 flex flex-wrap gap-6">
            {secondary.map((h) => (
              <div key={h.metric}>
                <p className="text-sm tabular-nums">
                  <span className="font-medium">{pct(h.value)}</span>{" "}
                  <span className="text-muted-foreground">
                    {SECONDARY_LABELS[h.metric] ?? h.metric} · {h.sampleSize}{" "}
                    answers
                  </span>
                </p>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 2. Where do I stand? */}
      {rivals.length > 1 && (
        <section>
          <h2 className="text-lg font-medium">Your market, as AI sees it</h2>
          <p className="mb-3 text-sm text-muted-foreground">
            How often each name is actively recommended, latest measurement.
          </p>
          <ol className="space-y-1.5">
            {rivals.map((rival, index) => (
              <li
                key={rival.name}
                className={`flex items-baseline justify-between gap-3 text-sm ${
                  rival.isClient ? "font-semibold" : ""
                }`}
              >
                <span>
                  <span className="tabular-nums text-muted-foreground">
                    {index + 1}.
                  </span>{" "}
                  {rival.name}
                  {rival.isClient && (
                    <span className="ml-1 text-xs font-normal text-muted-foreground">
                      (you)
                    </span>
                  )}
                </span>
                <span className="tabular-nums">
                  {pct(rival.value)}
                  <span className="ml-1 text-xs font-normal text-muted-foreground">
                    of {rival.sampleSize}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {/* 3. Trend, with its takeaway. */}
      {overview.trend.length > 1 &&
        (() => {
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
          const runs = [...byRun.values()];
          return (
            <section>
              <h2 className="mb-2 text-lg font-medium">Authority over time</h2>
              <AuthorityTrendChart data={runs} providers={providers} />
              {rec && overview.baseline && (
                <p className="mt-2 text-sm text-muted-foreground">
                  Recommendation rate moved {pct(overview.baseline.value)} →{" "}
                  {pct(rec.value)} across {runs.length} measurements since{" "}
                  {formatDate(overview.baseline.at)}.
                </p>
              )}
            </section>
          );
        })()}

      {/* 4. What have you done for me + when do I hear from you next. */}
      <section>
        <h2 className="mb-2 text-lg font-medium">Recent work</h2>
        {work.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Delivered work appears here as it completes.
          </p>
        ) : (
          <ul className="space-y-1.5 text-sm">
            {work.slice(0, 3).map((item, index) => (
              <li key={index} className="flex items-baseline justify-between gap-3">
                <span>{item.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {formatDate(item.at)}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-sm">
          <Link
            href={`/portal/${projectId}/work`}
            className="text-muted-foreground underline-offset-2 hover:underline"
          >
            All delivered work
          </Link>
          {overview.latestReport && (
            <>
              {" · "}
              <Link
                href={`/portal/${projectId}/reports`}
                className="text-muted-foreground underline-offset-2 hover:underline"
              >
                Latest report: {overview.latestReport.title}
              </Link>
            </>
          )}
        </p>
      </section>

      <p className="border-t pt-4 text-xs text-muted-foreground">
        {overview.lastMeasuredAt
          ? `Last measured ${formatDate(overview.lastMeasuredAt)}`
          : "Not yet measured"}
        {overview.measurementScheduled
          ? ` · next measurement scheduled ${nextMondayIso()}`
          : " · measurement paused"}
        . Every number is observed from repeated AI-assistant runs and carries
        its sample size; the methodology version is recorded with each figure.
      </p>
    </div>
  );
}
