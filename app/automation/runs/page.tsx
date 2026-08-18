/**
 * Every run, live and test, newest first. The list an operator scans when
 * something is wrong and they do not yet know where.
 */
import { PageHeader, PageShell } from "@/components/layout/page";
import Link from "next/link";
import { recentRuns } from "@/lib/automation/metrics";
import { Badge } from "@/components/ui/badge";
import { AutomationNav } from "@/components/automation/nav";
import { StateBadge } from "@/components/automation/state-badge";
import { EmptyState } from "@/components/automation/empty-state";

export const dynamic = "force-dynamic";

export default async function AutomationRunsPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string }>;
}) {
  const { mode } = await searchParams;
  const filter = mode === "live" || mode === "test" ? mode : undefined;
  const runs = await recentRuns({ mode: filter, limit: 100 });

  return (
    <PageShell>
      <PageHeader
        title="Runs"
        description={
          <>
        Production and test runs are distinguished in the database, not by
        convention — a test run physically cannot send, publish, or invoice.
          </>
        }
      />

      <AutomationNav current="runs" />

      <div className="mb-4 flex gap-2 text-sm">
        <Link
          href="/automation/runs"
          className={`rounded border px-2 py-1 ${filter === undefined ? "bg-muted font-medium" : ""}`}
        >
          All
        </Link>
        <Link
          href="/automation/runs?mode=live"
          className={`rounded border px-2 py-1 ${filter === "live" ? "bg-muted font-medium" : ""}`}
        >
          Live
        </Link>
        <Link
          href="/automation/runs?mode=test"
          className={`rounded border px-2 py-1 ${filter === "test" ? "bg-muted font-medium" : ""}`}
        >
          Test
        </Link>
      </div>

      {runs.length === 0 ? (
        <EmptyState
          title="No runs match"
          body="Start a test run from any workflow's page, or wait for a schedule, webhook, event or threshold to fire."
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs">
              <tr>
                <th className="p-2">Run</th>
                <th className="p-2">Workflow</th>
                <th className="p-2">Mode</th>
                <th className="p-2">State</th>
                <th className="p-2">Client</th>
                <th className="p-2">Trigger</th>
                <th className="p-2 text-right">Nodes</th>
                <th className="p-2 text-right">Approvals</th>
                <th className="p-2 text-right">Cost</th>
                <th className="p-2">Started</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id} className="border-t">
                  <td className="p-2">
                    <Link href={`/automation/runs/${run.id}`} className="font-mono text-xs underline">
                      {run.id.slice(0, 8)}
                    </Link>
                  </td>
                  <td className="p-2 font-mono text-xs">
                    {run.workflowKey}
                    <span className="text-muted-foreground"> v{run.workflowVersion}</span>
                  </td>
                  <td className="p-2 text-xs">
                    {run.mode === "test" ? <Badge variant="outline">test</Badge> : "live"}
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
                      <span className="text-destructive"> ({run.failedNodes})</span>
                    ) : null}
                  </td>
                  <td className="p-2 text-right tabular-nums text-xs">
                    {run.pendingApprovals > 0 ? (
                      <span className="font-medium">{run.pendingApprovals}</span>
                    ) : (
                      "—"
                    )}
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
    </PageShell>
  );
}
