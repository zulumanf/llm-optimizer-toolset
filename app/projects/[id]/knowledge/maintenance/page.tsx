import { notFound } from "next/navigation";
import { getProject } from "@/db/projects";
import { Badge } from "@/components/ui/badge";
import {
  EmptyState,
  PageHeader,
  PageShell,
  Section,
  Stat,
  StatGrid,
} from "@/components/layout/page";
import { KnowledgeLayerNav } from "@/components/knowledge/layer-nav";
import { openKnowledgeExceptions } from "@/lib/knowledge/maintenance/exceptions";
import { recentMaintenanceRuns } from "@/lib/knowledge/maintenance/service";
import { knowledgeHealth } from "@/lib/knowledge/maintenance/metrics";

export const dynamic = "force-dynamic";

const SEVERITY_TONE: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  critical: "destructive",
  high: "destructive",
  medium: "secondary",
  low: "outline",
};

const STATUS_TONE: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  completed: "default",
  running: "secondary",
  partial: "secondary",
  failed: "destructive",
};

/** A rate that renders "not measured" rather than 0% when nothing was seen. */
function pct(value: number | null): string {
  return value === null ? "not measured" : `${Math.round(value * 100)}%`;
}

export default async function MaintenancePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) notFound();

  const [exceptions, runs, health] = await Promise.all([
    openKnowledgeExceptions(id),
    recentMaintenanceRuns(10),
    knowledgeHealth(id),
  ]);

  return (
    <PageShell>
      <PageHeader
        title="Knowledge maintenance"
        crumbs={[{ label: project.name, href: `/projects/${id}` }, { label: "Maintenance" }]}
        description="Daily reconciliation and the weekly deeper review. Both ride the automation heartbeat and reconcile rather than regenerate — a job that rebuilt everything would hide the staleness it exists to detect."
      />
      <KnowledgeLayerNav projectId={id} />

      {/* ------------------------------------------------------ exceptions */}
      <Section title="Open exceptions">
        {exceptions.length === 0 ? (
          <EmptyState message="Nothing outstanding. Findings appear here and on the Today feed when a maintenance run detects one." />
        ) : (
          <ul className="space-y-2">
            {exceptions.map((exception) => (
              <li key={exception.id} className="rounded-md border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={SEVERITY_TONE[exception.severity] ?? "outline"}>
                    {exception.severity}
                  </Badge>
                  <span className="font-mono text-xs text-muted-foreground">
                    {exception.kind}
                  </span>
                  {exception.occurrences > 1 && (
                    // Persistence, not recurrence, is the signal worth showing.
                    <span className="text-xs text-muted-foreground">
                      seen in {exception.occurrences} runs
                    </span>
                  )}
                </div>
                <p className="mt-1 text-sm">{exception.summary}</p>
                {exception.recommendedAction && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {exception.recommendedAction}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* ---------------------------------------------------------- health */}
      <Section title="Health">
        <StatGrid>
          {[
            ["Sources", String(health.ingestion.sources)],
            ["Extraction failures", pct(health.ingestion.extractionFailureRate)],
            ["Approved claims", String(health.canonical.approved)],
            ["Evidence coverage", pct(health.canonical.evidenceCoverage)],
            ["Build no-op share", pct(health.compilation.noOpRate)],
            ["Build failures", pct(health.compilation.failureRate)],
            ["Stale in packets", pct(health.retrieval.staleInclusionRate)],
            ["Cross-client leakage", pct(health.retrieval.crossClientLeakageRate)],
          ].map(([label, value]) => (
            <Stat key={label} label={label!} value={value} />
          ))}
        </StatGrid>
        <p className="mt-2 text-xs text-muted-foreground">
          Agent quality is <strong>not measured</strong>. It needs a live provider run;
          deriving it from mock traffic would be a fabricated measurement.
        </p>
      </Section>

      {/* ------------------------------------------------------------ runs */}
      <Section title="Recent runs">
        {runs.length === 0 ? (
          <EmptyState message="No maintenance has run yet. It starts on the next automation heartbeat." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4">Window</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4">Checks</th>
                  <th className="py-2 pr-4">Opened</th>
                  <th className="py-2 pr-4">Resolved</th>
                  <th className="py-2 pr-4">Rebuilt / considered</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id} className="border-t">
                    <td className="py-2 pr-4 font-mono text-xs">
                      {run.kind} · {run.windowKey}
                    </td>
                    <td className="py-2 pr-4">
                      <Badge variant={STATUS_TONE[run.status] ?? "outline"}>{run.status}</Badge>
                    </td>
                    <td className="py-2 pr-4 tabular-nums">
                      {run.checksRun}
                      {run.checksFailed > 0 && (
                        <span className="text-destructive"> ({run.checksFailed} failed)</span>
                      )}
                    </td>
                    <td className="py-2 pr-4 tabular-nums">{run.exceptionsOpened}</td>
                    <td className="py-2 pr-4 tabular-nums">{run.exceptionsResolved}</td>
                    <td className="py-2 pr-4 tabular-nums">
                      {run.pagesRebuilt} / {run.pagesConsidered}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </PageShell>
  );
}
