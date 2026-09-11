/**
 * The automation dashboard: what is running, what is waiting, what is broken.
 *
 * Deliberately shows no labour-savings figure. That number needs a measured
 * manual baseline, none exists, and inventing one here would be exactly the kind
 * of unsupported claim the rest of this platform refuses to make.
 */
import { PageHeader, PageShell } from "@/components/layout/page";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, Clock, Plug, Radio, Workflow } from "lucide-react";
import { businessMetrics, recentRuns, workflowMetrics } from "@/lib/automation/metrics";
import { AUTOMATION_WORKFLOWS } from "@/lib/automation/workflows";
import { connectorStatusCounts, listConnectors } from "@/lib/connectors/registry";
import { listExceptions } from "@/lib/automation/runtime";
import { eventStats } from "@/db/events";
import { listTriggers, triggerStats } from "@/db/triggers";
import { encryptionAvailable } from "@/lib/security/envelope";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { AutomationNav } from "@/components/automation/nav";
import { EmptyState } from "@/components/automation/empty-state";
import { StateBadge } from "@/components/automation/state-badge";

export const dynamic = "force-dynamic";

function Tile({
  label,
  value,
  sub,
  alert,
  icon,
}: {
  label: string;
  value: string;
  sub?: string;
  alert?: boolean;
  icon?: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">{label}</p>
          {icon}
        </div>
        <p
          className={`mt-1 text-2xl font-semibold tabular-nums ${
            alert ? "text-destructive" : ""
          }`}
        >
          {value}
        </p>
        {sub ? <p className="mt-1 text-xs text-muted-foreground">{sub}</p> : null}
      </CardContent>
    </Card>
  );
}

export default async function AutomationDashboardPage() {
  const [business, metrics, runs, exceptions, events, triggers, stats] = await Promise.all([
    businessMetrics(),
    workflowMetrics(),
    recentRuns({ limit: 12 }),
    listExceptions({ status: "open", limit: 8 }),
    eventStats(8),
    listTriggers(),
    triggerStats(),
  ]);

  const connectorCounts = connectorStatusCounts();
  const liveRuns = metrics.reduce((sum, m) => sum + m.runs, 0);
  const enabledTriggers = triggers.filter((t) => t.enabled).length;
  const deadLettered = events.reduce((sum, e) => sum + e.deadLettered, 0);
  const keyReady = encryptionAvailable();

  return (
    <PageShell>
      <PageHeader
        title="Automation"
        description="Triggers start work, the graph executes it, gates hold anything consequential, and every failure becomes a visible exception. Nothing here sends, publishes, or invoices without a recorded decision."
      />

      <AutomationNav />

      {!keyReady ? (
        <div className="mb-6 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div className="text-sm">
            <p className="font-medium">Credential encryption is not configured.</p>
            <p className="text-muted-foreground">
              Set <code className="font-mono text-xs">AUTOMATION_CREDENTIAL_KEY</code> to a
              base64 32-byte value. Until then connector credentials cannot be
              stored or read — the layer fails closed rather than keeping secrets
              in the clear.
            </p>
          </div>
        </div>
      ) : null}

      <section className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile
          label="Open exceptions"
          value={String(business.openExceptions)}
          sub={`${business.overdueExceptions} past their SLA`}
          alert={business.overdueExceptions > 0}
          icon={<AlertTriangle className="size-4 text-muted-foreground" />}
        />
        <Tile
          label="Pending approvals"
          value={String(business.pendingApprovals)}
          sub={
            business.medianApprovalHours === null
              ? "no decisions recorded yet"
              : `median ${business.medianApprovalHours}h to decide`
          }
          alert={business.overdueApprovals > 0}
          icon={<Clock className="size-4 text-muted-foreground" />}
        />
        <Tile
          label="Live runs recorded"
          value={String(liveRuns)}
          sub={
            liveRuns === 0
              ? `${AUTOMATION_WORKFLOWS.length} workflows published · no live runs yet`
              : // Portfolio outcome rates were computed and rendered nowhere (C5).
                `${Math.round(
                  (metrics.reduce((s, m) => s + m.completed, 0) / liveRuns) * 100
                )}% completed · ${Math.round(
                  (metrics.reduce((s, m) => s + m.safelyStopped, 0) / liveRuns) * 100
                )}% safe-stopped · ${Math.round(
                  (metrics.reduce((s, m) => s + m.failed, 0) / liveRuns) * 100
                )}% failed`
          }
          icon={<Workflow className="size-4 text-muted-foreground" />}
        />
        <Tile
          label="Enabled triggers"
          value={String(enabledTriggers)}
          sub={`of ${triggers.length} declared`}
          icon={<Radio className="size-4 text-muted-foreground" />}
        />
      </section>

      <section className="mb-8 grid gap-3 md:grid-cols-2">
        <Card>
          <CardContent className="p-4">
            <div className="mb-2 flex items-center gap-2">
              <Plug className="size-4 text-muted-foreground" />
              <h2 className="text-sm font-medium">Connector readiness</h2>
            </div>
            <p className="text-sm text-muted-foreground">
              {listConnectors().length} adapters registered. Status is stated per
              adapter and never rolled into one reassuring total.
            </p>
            <div className="mt-3 flex flex-wrap gap-2 text-xs">
              <Badge variant="outline">
                {connectorCounts.verified} verified (run here)
              </Badge>
              <Badge variant="secondary">
                {connectorCounts.implemented_unverified} implemented, never run live
              </Badge>
              <Badge variant="outline">
                {connectorCounts.contract_only} contract only
              </Badge>
            </div>
            <Link
              href="/automation/connectors"
              className="mt-3 inline-block text-xs underline text-muted-foreground hover:text-foreground"
            >
              Connector detail →
            </Link>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="mb-2 flex items-center gap-2">
              <CheckCircle2 className="size-4 text-muted-foreground" />
              <h2 className="text-sm font-medium">Outreach safety</h2>
            </div>
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">Active sequences</dt>
                <dd className="tabular-nums">{business.activeSequences}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Suppressed contacts</dt>
                <dd className="tabular-nums">{business.suppressedContacts}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Exceptions / client</dt>
                <dd className="tabular-nums">
                  {business.exceptionsPerClient === null
                    ? "—"
                    : business.exceptionsPerClient.toFixed(1)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Human time saved</dt>
                {/* Stated as unmeasured rather than estimated. */}
                <dd className="text-xs text-muted-foreground">not measured</dd>
              </div>
            </dl>
            <p className="mt-2 text-xs text-muted-foreground">
              No labour-saving figure is shown: it would need a measured manual
              baseline, and none has been recorded.
            </p>
          </CardContent>
        </Card>
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-medium">Needs attention</h2>
        {exceptions.length === 0 ? (
          <EmptyState
            title="Nothing is waiting on a human"
            body="Open exceptions appear here, ordered by the deterministic priority formula with its components shown."
          />
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left text-xs">
                <tr>
                  <th className="p-2">Priority</th>
                  <th className="p-2">Kind</th>
                  <th className="p-2">Client</th>
                  <th className="p-2">Summary</th>
                  <th className="p-2">Recommended action</th>
                  <th className="p-2">Due</th>
                </tr>
              </thead>
              <tbody>
                {exceptions.map((exception) => (
                  <tr key={exception.id} className="border-t align-top">
                    <td className="p-2 tabular-nums font-medium">
                      {exception.priority.toFixed(1)}
                    </td>
                    <td className="p-2">
                      <Badge
                        variant={
                          exception.severity === "critical" || exception.severity === "high"
                            ? "destructive"
                            : "secondary"
                        }
                      >
                        {exception.kind}
                      </Badge>
                    </td>
                    <td className="p-2 text-xs text-muted-foreground">
                      {exception.projectName ?? "platform"}
                    </td>
                    <td className="p-2">{exception.summary}</td>
                    <td className="p-2 text-xs text-muted-foreground">
                      {exception.recommendedAction || "—"}
                    </td>
                    <td className="p-2 text-xs text-muted-foreground">
                      {exception.dueAt === null
                        ? "—"
                        : exception.dueAt < new Date()
                          ? "overdue"
                          : exception.dueAt.toISOString().slice(0, 16).replace("T", " ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="mb-8">
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-lg font-medium">Recent runs</h2>
          <Link
            href="/automation/runs"
            className="text-xs underline text-muted-foreground hover:text-foreground"
          >
            All runs →
          </Link>
        </div>
        {runs.length === 0 ? (
          <EmptyState
            title="No runs yet"
            body="Start one from a workflow's page, or wait for a schedule or an event to fire. A test run is always safe: it cannot send, publish, or invoice."
          />
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left text-xs">
                <tr>
                  <th className="p-2">Workflow</th>
                  <th className="p-2">Mode</th>
                  <th className="p-2">State</th>
                  <th className="p-2">Client</th>
                  <th className="p-2">Trigger</th>
                  <th className="p-2 text-right">Nodes</th>
                  <th className="p-2 text-right">Cost</th>
                  <th className="p-2">Started</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id} className="border-t">
                    <td className="p-2">
                      <Link href={`/automation/runs/${run.id}`} className="font-mono text-xs underline">
                        {run.workflowKey}
                      </Link>
                      <span className="ml-1 text-xs text-muted-foreground">
                        v{run.workflowVersion}
                      </span>
                    </td>
                    <td className="p-2">
                      {run.mode === "test" ? (
                        <Badge variant="outline">test</Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">live</span>
                      )}
                    </td>
                    <td className="p-2">
                      <StateBadge state={run.state} />
                    </td>
                    <td className="p-2 text-xs text-muted-foreground">
                      {run.projectName ?? "platform"}
                    </td>
                    <td className="p-2 text-xs text-muted-foreground">{run.trigger}</td>
                    <td className="p-2 text-right tabular-nums text-xs">
                      {run.nodeCount}
                      {run.failedNodes > 0 ? (
                        <span className="text-destructive"> ({run.failedNodes} failed)</span>
                      ) : null}
                    </td>
                    <td className="p-2 text-right tabular-nums text-xs">
                      ${(run.costMicroUsd / 1_000_000).toFixed(4)}
                    </td>
                    <td className="p-2 text-xs text-muted-foreground">
                      {run.startedAt.toISOString().slice(0, 16).replace("T", " ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-lg font-medium">Event delivery</h2>
          <Link
            href="/automation/events"
            className="text-xs underline text-muted-foreground hover:text-foreground"
          >
            Event log →
          </Link>
        </div>
        {events.length === 0 ? (
          <EmptyState
            title="No events published yet"
            body="Domain events are the append-only record of what changed. Publishing one is transactional with the change that caused it."
          />
        ) : (
          <>
            {deadLettered > 0 ? (
              <p className="mb-2 text-sm text-destructive">
                {deadLettered} delivery attempt(s) dead-lettered — they need a fix
                and an explicit replay.
              </p>
            ) : null}
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-left text-xs">
                  <tr>
                    <th className="p-2">Type</th>
                    <th className="p-2 text-right">Published</th>
                    <th className="p-2 text-right">Delivered</th>
                    <th className="p-2 text-right">Dead-lettered</th>
                    <th className="p-2">Last</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((entry) => (
                    <tr key={entry.type} className="border-t">
                      <td className="p-2 font-mono text-xs">{entry.type}</td>
                      <td className="p-2 text-right tabular-nums">{entry.published}</td>
                      <td className="p-2 text-right tabular-nums">{entry.delivered}</td>
                      <td
                        className={`p-2 text-right tabular-nums ${
                          entry.deadLettered > 0 ? "text-destructive" : ""
                        }`}
                      >
                        {entry.deadLettered}
                      </td>
                      <td className="p-2 text-xs text-muted-foreground">
                        {entry.lastAt?.toISOString().slice(0, 16).replace("T", " ") ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <p className="mt-8 text-xs text-muted-foreground">
        {stats.size} trigger(s) have fire history. Priority uses the deterministic
        formula in <code className="font-mono">lib/workflow/exceptions.ts</code>;
        every component is visible on the exceptions page.
      </p>
    </PageShell>
  );
}
