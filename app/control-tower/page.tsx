import Link from "next/link";
import { CheckCircle2, AlertTriangle } from "lucide-react";
import {
  portfolioMetrics,
  latestHealthByClient,
  listExecutiveBriefs,
} from "@/db/control-tower";
import { listActiveProjects } from "@/db/projects";
import { BriefGenerator } from "@/components/control-tower/brief-generator";
import { actionRequiredQueue } from "@/lib/control-tower/queue";
import { listDriftSignals } from "@/lib/drift/detect";
import { DriftSignals } from "@/components/control-tower/drift-signals";
import { computeCapacity, automationByWorkflow } from "@/lib/control-tower/capacity";
import { PRIORITY_FORMULA_VERSION } from "@/lib/workflow/exceptions";
import { HEALTH_WEIGHTS_VERSION } from "@/lib/control-tower/health";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { PriorityBreakdownDetails } from "@/components/control-tower/priority-breakdown";
import { ResolveException } from "@/components/control-tower/resolve-exception";
import { HealthComponents } from "@/components/control-tower/health-components";

export const dynamic = "force-dynamic";

const SEVERITY_VARIANT = {
  critical: "destructive",
  high: "destructive",
  medium: "default",
  low: "outline",
} as const;

const SOURCE_LABEL: Record<string, string> = {
  workflow_exception: "Exception",
  workflow_approval: "Approval",
  gap_finding: "Opportunity",
  accuracy_finding: "Factual problem",
  content_approval: "Content",
};

function Tile({
  label,
  value,
  sub,
  alert,
}: {
  label: string;
  value: string;
  sub?: string;
  alert?: boolean;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p
          className={`mt-1 text-2xl font-semibold tabular-nums ${alert ? "text-destructive" : ""}`}
        >
          {value}
        </p>
        {sub && <p className="mt-1 text-xs text-muted-foreground">{sub}</p>}
      </CardContent>
    </Card>
  );
}

function periodOfLastDays(days: number): { start: string; end: string } {
  const end = new Date();
  const start = new Date(end.getTime() - days * 86_400_000);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

export default async function ControlTowerPage() {
  const period = periodOfLastDays(28);
  const [metrics, queue, driftSignals, health, capacity, automation, activeProjects, briefs] =
    await Promise.all([
      portfolioMetrics(),
      actionRequiredQueue({ limit: 40 }),
      listDriftSignals("open"),
      latestHealthByClient(),
      computeCapacity(period),
      automationByWorkflow(period),
      listActiveProjects(),
      listExecutiveBriefs(8),
    ]);

  return (
    <div className="mx-auto max-w-6xl p-6">
      <div className="mb-1 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Control tower</h1>
        <Link
          href="/workflows"
          className="text-sm text-muted-foreground underline hover:text-foreground"
        >
          Workflow runs
        </Link>
      </div>
      <p className="mb-6 text-sm text-muted-foreground">
        One queue across every client, ordered by a formula you can read
        ({PRIORITY_FORMULA_VERSION}). Nothing here is a number without its
        components — click a score to see how it was built.
      </p>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Tile
          label="Active clients"
          value={String(metrics.activeClients)}
          sub={`${metrics.onboardingClients} never measured · ${metrics.atRiskClients} at risk`}
          alert={metrics.atRiskClients > 0}
        />
        <Tile
          label="Workflows"
          value={`${metrics.workflowsRunning} running`}
          sub={`${metrics.workflowsBlocked} blocked · ${metrics.safeStops7d} safe stops (7d)`}
          alert={metrics.workflowsBlocked > 0}
        />
        <Tile
          label="Approvals pending"
          value={String(metrics.approvalsPending)}
          sub={`${metrics.approvalsOverdue} overdue`}
          alert={metrics.approvalsOverdue > 0}
        />
        <Tile
          label="Open exceptions"
          value={String(metrics.openExceptions)}
          sub={`${metrics.criticalExceptions} critical`}
          alert={metrics.criticalExceptions > 0}
        />
        <Tile
          label="Automation (28d)"
          value={
            capacity.automationRate === null
              ? "—"
              : `${(capacity.automationRate * 100).toFixed(0)}%`
          }
          sub={
            capacity.automationRate === null
              ? "no settled node runs yet"
              : "node runs settled without a human"
          }
        />
        <Tile
          label="Operator capacity"
          value={
            capacity.supportableClients === null
              ? "insufficient data"
              : `${capacity.supportableClients} clients`
          }
          sub={`${capacity.observationCount} observation(s)`}
        />
        <Tile
          label="Human minutes (28d)"
          value={String(capacity.humanMinutesTotal)}
          sub={`${capacity.approvalsTotal} approvals · ${capacity.exceptionsTotal} exceptions`}
        />
        {/* Counts benchmark `runs`, not workflow_runs — labelled as such so it
            stops masquerading as a workflow metric among workflow tiles. */}
        <Tile
          label="Failed benchmark runs (7d)"
          value={String(metrics.failedRuns7d)}
          alert={metrics.failedRuns7d > 0}
        />
      </div>

      <p className="mb-6 rounded-md border border-dashed p-3 text-xs text-muted-foreground">
        <strong>Capacity note.</strong> {capacity.notes}
      </p>

      <DriftSignals signals={driftSignals} />

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-medium">
          Action required{" "}
          <span className="text-sm font-normal text-muted-foreground">
            ({queue.length})
          </span>
        </h2>
        {queue.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed p-12 text-center">
            <CheckCircle2 className="size-8 text-success" />
            <p className="text-sm text-muted-foreground">
              Nothing needs a decision across {metrics.activeClients} client
              {metrics.activeClients === 1 ? "" : "s"} right now.
            </p>
          </div>
        ) : (
          <div className="divide-y rounded-lg border">
            {queue.map((item) => (
              <div key={`${item.source}-${item.id}`} className="p-3">
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 w-12 shrink-0 text-right text-lg font-semibold tabular-nums">
                    {item.priority.total.toFixed(0)}
                  </span>
                  <Badge variant={SEVERITY_VARIANT[item.severity]} className="mt-1 shrink-0">
                    {SOURCE_LABEL[item.source] ?? item.source}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <Link href={item.href} className="text-sm font-medium hover:underline">
                      {item.projectName}
                    </Link>
                    <p className="text-sm text-muted-foreground">{item.summary}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {item.recommendedAction}
                      {item.dueAt
                        ? ` · due ${item.dueAt.toISOString().slice(0, 10)}`
                        : ""}
                    </p>
                    <PriorityBreakdownDetails breakdown={item.priority} />
                    {item.source === "workflow_exception" && (
                      <div className="mt-1">
                        <ResolveException exceptionId={item.id} />
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-medium">Executive briefs</h2>
        <div className="mb-6 rounded-lg border p-3">
          <BriefGenerator
            projects={activeProjects.map((p) => ({ id: p.id, name: p.name }))}
          />
          <p className="mt-2 text-xs text-muted-foreground">
            Monthly and quarterly briefs cover the previous full period and
            pass the same executive-reporting gate as the weekly workflow — a
            refusal means the evidence is not there yet, not an error.
          </p>
        </div>
        {briefs.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No briefs generated yet — the weekly workflow writes one per
            client per week once measurement is running.
          </p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {briefs.map((brief) => (
              <li key={brief.id} className="flex items-center gap-3 p-3 text-sm">
                <Badge variant="outline" className="shrink-0">
                  {brief.kind}
                </Badge>
                <Link
                  href={`/control-tower/briefs/${brief.id}`}
                  className="min-w-0 truncate font-medium hover:underline"
                >
                  {brief.sections.headline ??
                    `${brief.projectName} — ${brief.kind} brief`}
                </Link>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                  {brief.periodStart.toISOString().slice(0, 10)} →{" "}
                  {brief.periodEnd.toISOString().slice(0, 10)}
                </span>
              </li>
            ))}
          </ul>
        )}

        <h2 className="mb-2 text-lg font-medium">
          Client health{" "}
          <span className="text-sm font-normal text-muted-foreground">
            (weights {HEALTH_WEIGHTS_VERSION})
          </span>
        </h2>
        {health.length === 0 ? (
          <div className="flex items-start gap-3 rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <p>
              No health snapshot has been computed yet. Health is written by the
              weekly brief workflow — run <code>weekly_brief_v1</code> for a
              client and it will appear here with its components.
            </p>
          </div>
        ) : (
          <div className="divide-y rounded-lg border">
            {health.map((row) => (
              <div key={row.projectId} className="p-3">
                <div className="flex items-baseline gap-3">
                  <span className="w-12 text-right text-lg font-semibold tabular-nums">
                    {row.overall === null ? "—" : row.overall.toFixed(2)}
                  </span>
                  <Link
                    href={`/projects/${row.projectId}`}
                    className="text-sm font-medium hover:underline"
                  >
                    {row.projectName}
                  </Link>
                  <span className="text-xs text-muted-foreground">
                    confidence {(row.confidence * 100).toFixed(0)}%
                    {row.missing.length > 0 && ` · ${row.missing.length} component(s) missing`}
                    {` · period ending ${row.periodEnd.toISOString().slice(0, 10)}`}
                  </span>
                </div>
                <HealthComponents components={row.components} missing={row.missing} />
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-lg font-medium">
          Measured automation{" "}
          <span className="text-sm font-normal text-muted-foreground">
            (last 28 days — observed, not targeted)
          </span>
        </h2>
        {automation.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
            No workflow nodes have settled yet, so there is nothing to measure.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left text-xs">
                <tr>
                  <th className="p-2">Workflow</th>
                  <th className="p-2 text-right">Nodes settled</th>
                  <th className="p-2 text-right">Without a human</th>
                  <th className="p-2 text-right">Rate</th>
                </tr>
              </thead>
              <tbody>
                {automation.map((row) => (
                  <tr key={row.key} className="border-t">
                    <td className="p-2 font-mono text-xs">{row.key}</td>
                    <td className="p-2 text-right tabular-nums">{row.settled}</td>
                    <td className="p-2 text-right tabular-nums">{row.autonomous}</td>
                    <td className="p-2 text-right tabular-nums">
                      {(row.rate * 100).toFixed(0)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
