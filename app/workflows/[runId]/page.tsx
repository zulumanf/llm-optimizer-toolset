import { PageHeader, PageShell } from "@/components/layout/page";
import Link from "next/link";
import { notFound } from "next/navigation";
import { workflowRunDetail } from "@/db/control-tower";
import { Badge } from "@/components/ui/badge";
import { ApprovalDecision } from "@/components/approvals/approval-decision";
import { RunGraph } from "@/components/workflows/run-graph";
import { StateBadge } from "@/components/automation/state-badge";

export const dynamic = "force-dynamic";


export default async function WorkflowRunPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;
  const detail = await workflowRunDetail(runId);
  if (!detail) notFound();

  const { run, spec, nodes, transitions, approvals, gates, timing } = detail;
  const pendingApprovals = approvals.filter((a) => a.decision === null);

  return (
    <PageShell>
      <PageHeader
        title={run.definitionName}
        description={
          <>
            <span className="font-mono text-xs">{run.definitionKey}</span> v{run.version}
            {run.projectName ? ` · ${run.projectName}` : ""} · started{" "}
            {run.startedAt.toISOString().slice(0, 16).replace("T", " ")}
          </>
        }
        actions={
          <Link
            href="/workflows"
            className="text-sm text-muted-foreground underline hover:text-foreground"
          >
            All workflows
          </Link>
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Badge variant={run.state === "failed" ? "destructive" : "default"}>
          {run.state.replace(/_/g, " ")}
        </Badge>
        <span className="text-sm text-muted-foreground">
          {run.nodeCounts.succeeded} succeeded · {run.nodeCounts.failed} failed ·{" "}
          {run.nodeCounts.waiting} waiting
        </span>
        <span className="text-sm text-muted-foreground">
          ${(run.costMicroUsd / 1_000_000).toFixed(4)}
        </span>
      </div>
      {run.stopReason && (
        <p className="mb-6 rounded-md border border-dashed p-3 text-sm">
          <strong>Stopped:</strong> {run.stopReason}
        </p>
      )}

      {pendingApprovals.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-2 text-lg font-medium">Waiting for you</h2>
          <div className="space-y-3">
            {pendingApprovals.map((approval) => (
              <ApprovalDecision
                key={approval.id}
                approvalId={approval.id}
                summary={approval.summary}
                riskLevel={approval.riskLevel}
                requiredRole={approval.requiredRole}
                requestedAt={approval.requestedAt.toISOString()}
                dueAt={approval.dueAt?.toISOString() ?? null}
              />
            ))}
          </div>
        </section>
      )}

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-medium">Graph</h2>
        <RunGraph spec={spec} nodes={nodes} criticalPath={timing.criticalPath} />
        <p className="mt-2 text-xs text-muted-foreground">
          Critical path {(timing.criticalPathMs / 1000).toFixed(1)}s of{" "}
          {(timing.totalNodeMs / 1000).toFixed(1)}s total node time —{" "}
          {(timing.parallelizableShare * 100).toFixed(0)}% of the work ran off the
          critical path.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-medium">
          Node runs{" "}
          <span className="text-sm font-normal text-muted-foreground">({nodes.length})</span>
        </h2>
        {nodes.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
            No node has executed yet — the run is queued.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left text-xs">
                <tr>
                  <th className="p-2">Node</th>
                  <th className="p-2">Fan key</th>
                  <th className="p-2">State</th>
                  <th className="p-2 text-right">Attempts</th>
                  <th className="p-2 text-right">Duration</th>
                  <th className="p-2 text-right">Cost</th>
                  <th className="p-2">Detail</th>
                </tr>
              </thead>
              <tbody>
                {nodes.map((node) => (
                  <tr key={node.id} className="border-t align-top">
                    <td className="p-2 font-mono text-xs">{node.nodeKey}</td>
                    <td className="p-2 font-mono text-xs text-muted-foreground">
                      {node.fanKey || "—"}
                    </td>
                    <td className="p-2">
                      <StateBadge state={node.state} />
                      {node.humanTouch && (
                        <span className="ml-1 text-xs text-muted-foreground">human</span>
                      )}
                    </td>
                    <td className="p-2 text-right tabular-nums">{node.attempts}</td>
                    <td className="p-2 text-right tabular-nums">
                      {node.durationMs === null ? "—" : `${(node.durationMs / 1000).toFixed(1)}s`}
                    </td>
                    <td className="p-2 text-right tabular-nums">
                      {node.costMicroUsd === 0
                        ? "—"
                        : `$${(node.costMicroUsd / 1_000_000).toFixed(4)}`}
                    </td>
                    <td className="max-w-md p-2 text-xs text-muted-foreground">
                      {node.error ?? (node.output ? summarise(node.output) : "—")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {gates.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-2 text-lg font-medium">Quality gates</h2>
          <div className="space-y-3">
            {gates.map((gate, index) => (
              <div key={index} className="rounded-lg border p-3">
                <div className="flex items-center gap-2">
                  <Badge variant={gate.outcome === "pass" ? "outline" : "destructive"}>
                    {gate.outcome.replace(/_/g, " ")}
                  </Badge>
                  <span className="text-sm font-medium">{gate.gateType.replace(/_/g, " ")}</span>
                </div>
                <pre className="mt-2 overflow-x-auto text-xs text-muted-foreground">
                  {JSON.stringify(gate.checks, null, 2)}
                </pre>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-2 text-lg font-medium">
          Transition history{" "}
          <span className="text-sm font-normal text-muted-foreground">
            ({transitions.length}) — append-only
          </span>
        </h2>
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs">
              <tr>
                <th className="p-2">When</th>
                <th className="p-2">Scope</th>
                <th className="p-2">Node</th>
                <th className="p-2">Transition</th>
                <th className="p-2">Actor</th>
                <th className="p-2">Reason</th>
              </tr>
            </thead>
            <tbody>
              {transitions.map((transition, index) => (
                <tr key={index} className="border-t">
                  <td className="p-2 text-xs text-muted-foreground">
                    {transition.at.toISOString().slice(11, 19)}
                  </td>
                  <td className="p-2 text-xs">{transition.scope}</td>
                  <td className="p-2 font-mono text-xs">{transition.nodeKey ?? "—"}</td>
                  <td className="p-2 text-xs">
                    {transition.fromState ?? "∅"} → {transition.toState}
                  </td>
                  <td className="p-2 text-xs">{transition.actor}</td>
                  <td className="p-2 text-xs text-muted-foreground">{transition.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </PageShell>
  );
}

function summarise(output: Record<string, unknown>): string {
  const text = JSON.stringify(output);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}
