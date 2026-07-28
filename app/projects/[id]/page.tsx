import Link from "next/link";
import { notFound } from "next/navigation";
import { getProject } from "@/db/projects";
import { getCurrentUser } from "@/lib/auth";
import { authorityTrend, selfTiles, dataHealth } from "@/db/dashboard";
import { latestScoresByCompany, listComparisonCompanies } from "@/db/competitors";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { ProjectFormDialog } from "@/components/projects/project-form-dialog";
import { ArchiveControls } from "@/components/projects/archive-controls";
import {
  AuthorityTrendChart,
  type TrendDatum,
} from "@/components/charts/authority-trend";
import { AuthorityBarChart } from "@/components/charts/authority-bar";
import { formatDate } from "@/lib/format";

function StatTile({
  label,
  value,
  delta,
  sub,
}: {
  label: string;
  value: string;
  delta?: number | null;
  sub?: string;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <div className="mt-1 flex items-baseline gap-2">
          <span className="text-2xl font-semibold">{value}</span>
          {delta !== undefined && delta !== null && (
            <span
              className={
                delta >= 0 ? "text-sm text-success" : "text-sm text-destructive"
              }
            >
              {delta >= 0 ? "▲" : "▼"} {Math.abs(delta).toFixed(1)}
            </span>
          )}
        </div>
        {sub && <p className="mt-1 text-xs text-muted-foreground">{sub}</p>}
      </CardContent>
    </Card>
  );
}

export default async function ProjectDashboardPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [project, user] = await Promise.all([getProject(id), getCurrentUser()]);
  if (!project) notFound();

  const [tiles, trend, comparison, latestScores, health] = await Promise.all([
    selfTiles(id),
    authorityTrend(id),
    listComparisonCompanies(id),
    latestScoresByCompany(id),
    dataHealth(id),
  ]);

  const tile = (metric: string) => tiles.find((t) => t.metric === metric);
  const authority = tile("authority_score");
  const rec = tile("recommendation_rate");
  const sov = tile("share_of_voice");

  // Pivot trend rows into per-run datums for the chart
  const trendByRun = new Map<string, TrendDatum>();
  for (const point of trend) {
    if (!trendByRun.has(point.runId)) {
      trendByRun.set(point.runId, {
        runLabel: point.runLabel,
        startedAt: point.startedAt.toISOString(),
        scoringVersion: point.scoringVersion,
        promptSetVersionId: point.promptSetVersionId,
        values: {},
      });
    }
    trendByRun.get(point.runId)!.values[point.provider] = Number(point.value);
  }
  const trendData = [...trendByRun.values()];
  const providers = [
    ...new Set(trend.map((p) => p.provider).filter((p) => p !== "all")),
  ];

  const barData = comparison
    .map((c) => ({
      companyName: c.companyName,
      isSelf: c.isSelf,
      value: latestScores.get(c.companyId)?.authority_score ?? null,
    }))
    .filter((c): c is { companyName: string; isSelf: boolean; value: number } =>
      c.value !== null
    );

  return (
    <div className="mx-auto max-w-7xl p-6">
      <nav className="mb-3 text-sm text-muted-foreground">
        <Link href="/projects" className="hover:text-foreground">Projects</Link>
        {" / "}{project.name}
      </nav>

      {project.status === "archived" && (
        <div className="mb-4 rounded-md border border-warning/50 bg-warning/10 px-4 py-2 text-sm">
          This project is archived — editing is disabled until it is unarchived.
        </div>
      )}

      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold">{project.name}</h1>
            <Badge variant={project.status === "active" ? "default" : "outline"}>
              {project.status}
            </Badge>
          </div>
          {project.description && (
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              {project.description}
            </p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">
            Created {formatDate(project.createdAt)}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          {project.status === "active" && (
            <ProjectFormDialog mode="edit" project={project} />
          )}
          <ArchiveControls project={project} isAdmin={user.role === "admin"} />
        </div>
      </div>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Authority score (all providers)"
          value={authority ? authority.value.toFixed(1) : "—"}
          delta={
            authority?.previousValue != null
              ? authority.value - authority.previousValue
              : null
          }
          sub={authority ? `N=${authority.sampleSize} · v1.0` : "no scored runs"}
        />
        <StatTile
          label="Recommendation rate"
          value={rec ? `${(rec.value * 100).toFixed(1)}%` : "—"}
          delta={
            rec?.previousValue != null
              ? (rec.value - rec.previousValue) * 100
              : null
          }
          sub={rec ? `N=${rec.sampleSize}` : undefined}
        />
        <StatTile
          label="Share of voice"
          value={sov ? `${(sov.value * 100).toFixed(1)}%` : "—"}
          sub={sov ? `N=${sov.sampleSize}` : undefined}
        />
        <StatTile
          label="Data health"
          value={
            health.lastRunStatus
              ? `${health.lastRunStatus}`
              : "no runs"
          }
          sub={`${health.pendingReviews} pending review · ${health.failedJobs} failed jobs`}
        />
      </div>

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardContent className="p-4">
            <p className="mb-2 text-sm font-medium">
              Parva authority over runs{" "}
              <span className="font-normal text-muted-foreground">
                (scoring v1.0 — boundaries annotated)
              </span>
            </p>
            <AuthorityTrendChart data={trendData} providers={providers} />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="mb-2 text-sm font-medium">
              Authority by company{" "}
              <span className="font-normal text-muted-foreground">
                (latest scored run, all providers)
              </span>
            </p>
            <AuthorityBarChart data={barData} />
          </CardContent>
        </Card>
      </div>

    </div>
  );
}
