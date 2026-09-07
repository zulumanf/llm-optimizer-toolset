/**
 * The run inspector: node inputs and outputs, routing decisions, evidence,
 * confidence, cost, and — for a test run — the ledger of what would have
 * happened.
 *
 * This is the page that makes a test run worth doing. "It ran green" is not the
 * output of a test run; "here is exactly what it would have sent, and here is
 * where it stopped" is.
 */
import { PageHeader, PageShell } from "@/components/layout/page";
import Link from "next/link";
import { notFound } from "next/navigation";
import { sql } from "@/db/client";
import { getRun } from "@/lib/automation/runtime";
import { nodeRunsForRun } from "@/lib/automation/metrics";
import { testActionsFor } from "@/lib/automation/testmode";
import { AUTOMATION_WORKFLOWS } from "@/lib/automation/workflows";
import { criticalPath } from "@/lib/workflow/graph";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { AutomationNav } from "@/components/automation/nav";
import { GraphView } from "@/components/automation/graph-view";
import { StateBadge } from "@/components/automation/state-badge";
import { EmptyState } from "@/components/automation/empty-state";
import { ApprovalDecision } from "@/components/approvals/approval-decision";
import { RetryNodeButton } from "@/components/automation/retry-node-button";

export const dynamic = "force-dynamic";

function Json({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <span className="text-xs text-muted-foreground">none</span>;
  }
  return (
    <pre className="max-h-64 overflow-auto rounded bg-muted/40 p-2 text-[11px] leading-relaxed">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

export default async function RunDetailPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;

  let run;
  try {
    run = await getRun(runId);
  } catch {
    notFound();
  }

  const [nodes, testActions, approvals, transitions, exceptions, gateResults] =
    await Promise.all([
      nodeRunsForRun(runId),
      testActionsFor(runId),
      sql`
        select id, node_run_id, summary, action_type, risk_level, required_role,
               decision, decided_by, decided_at, rationale, due_at, evidence_ids, detail
        from workflow_approvals where workflow_run_id = ${runId}
        order by requested_at asc
      `,
      sql`
        select scope, from_state, to_state, actor, reason, node_version, at
        from workflow_transitions where workflow_run_id = ${runId}
        order by at asc
      `,
      sql`
        select kind, severity, summary, recommended_action, status
        from workflow_exceptions where workflow_run_id = ${runId}
        order by created_at desc
      `,
      sql`
        select gate_type, gate_version, outcome, checks
        from quality_gate_results where workflow_run_id = ${runId}
        order by evaluated_at asc
      `,
    ]);

  const definition = AUTOMATION_WORKFLOWS.find((w) => w.key === run.definitionKey);
  const stateByNode: Record<string, string> = {};
  for (const node of nodes) stateByNode[node.nodeKey] = node.state;

  const path =
    definition === undefined
      ? null
      : criticalPath(
          definition,
          nodes
            .filter((node) => node.durationSeconds !== null)
            .map((node) => ({
              nodeKey: node.nodeKey,
              fanKey: node.fanKey,
              durationMs: (node.durationSeconds ?? 0) * 1000,
            }))
        );

  const pendingApprovals = approvals.filter((a) => a.decision === null);

  return (
    <PageShell>
      <PageHeader
        title={run.definitionKey}
        badge={
          <>
            <Badge variant="outline">v{run.workflowVersion}</Badge>
            <StateBadge state={run.state} />
            {run.mode === "test" ? <Badge variant="outline">test run</Badge> : null}
          </>
        }
        description={<span className="font-mono text-xs">{run.id}</span>}
      />

      {run.mode === "test" ? (
        <div className="mt-3 rounded-lg border border-dashed p-3 text-sm">
          <p className="font-medium">This is a test run.</p>
          <p className="text-muted-foreground">
            Connector reads came from fixtures and every consequential action was
            refused and recorded. Nothing here reached a client, a prospect, or a
            billing system.
          </p>
        </div>
      ) : null}

      <div className="mt-4">
        <AutomationNav current="runs" />
      </div>

      <section className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Cost</p>
            <p className="mt-1 text-lg font-medium tabular-nums">
              ${(run.costMicroUsd / 1_000_000).toFixed(4)}
            </p>
            <p className="text-xs text-muted-foreground">
              cap{" "}
              {run.costCapMicroUsd === null
                ? "none"
                : `$${(run.costCapMicroUsd / 1_000_000).toFixed(2)}`}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Nodes</p>
            <p className="mt-1 text-lg font-medium tabular-nums">{nodes.length}</p>
            <p className="text-xs text-muted-foreground">
              {nodes.filter((n) => n.state === "succeeded").length} succeeded,{" "}
              {nodes.filter((n) => n.state === "failed_terminal").length} failed
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Human touches</p>
            <p className="mt-1 text-lg font-medium tabular-nums">
              {nodes.filter((n) => n.humanTouch).length}
            </p>
            <p className="text-xs text-muted-foreground">
              {pendingApprovals.length} approval(s) pending
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Critical path</p>
            <p className="mt-1 text-lg font-medium tabular-nums">
              {path === null ? "—" : `${Math.round(path.durationMs / 1000)}s`}
            </p>
            <p className="text-xs text-muted-foreground">
              {path === null ? "not computable" : `${path.path.length} node(s)`}
            </p>
          </CardContent>
        </Card>
      </section>

      {pendingApprovals.length > 0 ? (
        <section className="mb-8">
          <h2 className="mb-2 text-lg font-medium">Waiting on you</h2>
          <div className="space-y-3">
            {pendingApprovals.map((approval) => (
              <Card key={approval.id as string}>
                <CardContent className="p-4">
                  <div className="mb-2 flex flex-wrap items-baseline gap-2">
                    <p className="text-sm font-medium">{approval.summary as string}</p>
                    <Badge
                      variant={
                        approval.riskLevel === "critical" || approval.riskLevel === "high"
                          ? "destructive"
                          : "secondary"
                      }
                    >
                      {approval.riskLevel as string}
                    </Badge>
                    <Badge variant="outline">
                      requires {approval.requiredRole as string}
                    </Badge>
                    {approval.dueAt !== null ? (
                      <span className="text-xs text-muted-foreground">
                        due{" "}
                        {(approval.dueAt as Date).toISOString().slice(0, 16).replace("T", " ")}
                      </span>
                    ) : null}
                  </div>
                  <details className="mb-3">
                    <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                      What you are approving
                    </summary>
                    <div className="mt-2">
                      <Json value={approval.detail} />
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {((approval.evidenceIds as string[]) ?? []).length} evidence
                      id(s) attached.
                    </p>
                  </details>
                  <ApprovalDecision approvalId={approval.id as string} compact />
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      ) : null}

      {run.mode === "test" ? (
        <section className="mb-8">
          <h2 className="mb-2 text-lg font-medium">Would have happened</h2>
          {testActions.length === 0 ? (
            <EmptyState
              title="No consequential action was reached"
              body="This run did not get as far as anything that would have left the platform, or its path did not include one."
            />
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-left text-xs">
                  <tr>
                    <th className="p-2">Capability</th>
                    <th className="p-2">Why it was refused</th>
                    <th className="p-2">Payload (redacted)</th>
                  </tr>
                </thead>
                <tbody>
                  {testActions.map((action) => (
                    <tr key={action.id} className="border-t align-top">
                      <td className="p-2 font-mono text-xs">{action.capability}</td>
                      <td className="p-2 max-w-sm text-xs text-muted-foreground">
                        {action.reason}
                      </td>
                      <td className="p-2">
                        <Json value={action.wouldHaveSent} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}

      {exceptions.length > 0 ? (
        <section className="mb-8">
          <h2 className="mb-2 text-lg font-medium">Exceptions raised</h2>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left text-xs">
                <tr>
                  <th className="p-2">Kind</th>
                  <th className="p-2">Severity</th>
                  <th className="p-2">Summary</th>
                  <th className="p-2">Recommended action</th>
                  <th className="p-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {exceptions.map((exception, index) => (
                  <tr key={index} className="border-t align-top">
                    <td className="p-2 font-mono text-xs">{exception.kind as string}</td>
                    <td className="p-2 text-xs">{exception.severity as string}</td>
                    <td className="p-2">{exception.summary as string}</td>
                    <td className="p-2 text-xs text-muted-foreground">
                      {(exception.recommendedAction as string) || "—"}
                    </td>
                    <td className="p-2 text-xs">{exception.status as string}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {gateResults.length > 0 ? (
        <section className="mb-8">
          <h2 className="mb-2 text-lg font-medium">Quality gates</h2>
          <div className="space-y-2">
            {gateResults.map((gate, index) => (
              <details key={index} className="rounded-lg border p-3">
                <summary className="cursor-pointer text-sm">
                  <span className="font-mono text-xs">{gate.gateType as string}</span>{" "}
                  <Badge variant={gate.outcome === "pass" ? "outline" : "destructive"}>
                    {gate.outcome as string}
                  </Badge>{" "}
                  <span className="text-xs text-muted-foreground">
                    {gate.gateVersion as string}
                  </span>
                </summary>
                <div className="mt-2">
                  <Json value={gate.checks} />
                </div>
              </details>
            ))}
          </div>
        </section>
      ) : null}

      {definition !== undefined ? (
        <section className="mb-8">
          <h2 className="mb-2 text-lg font-medium">Graph, with this run&rsquo;s states</h2>
          <GraphView
            nodes={definition.nodes}
            edges={definition.edges}
            states={stateByNode}
          />
        </section>
      ) : null}

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-medium">Node runs</h2>
        {nodes.length === 0 ? (
          <EmptyState
            title="No node has executed yet"
            body="The run has been created but the worker has not advanced it. Node instances appear here as they are claimed."
          />
        ) : (
          <div className="space-y-2">
            {nodes.map((node) => (
              <details key={node.id} className="rounded-lg border p-3">
                <summary className="cursor-pointer">
                  <span className="font-mono text-xs">{node.nodeKey}</span>
                  {node.fanKey.length > 0 ? (
                    <span className="ml-1 font-mono text-[11px] text-muted-foreground">
                      [{node.fanKey}]
                    </span>
                  ) : null}{" "}
                  <StateBadge state={node.state} />{" "}
                  <span className="text-xs text-muted-foreground">
                    {node.nodeName} · {node.nodeType.replace(/_/g, " ")}
                    {node.durationSeconds !== null ? ` · ${node.durationSeconds}s` : ""}
                    {node.confidence !== null
                      ? ` · confidence ${node.confidence.toFixed(2)}`
                      : ""}
                    {node.attempts > 1 ? ` · ${node.attempts} attempts` : ""}
                    {node.humanTouch ? " · human" : ""}
                  </span>
                </summary>

                {node.error !== null ? (
                  <p className="mt-2 rounded bg-destructive/10 p-2 text-xs text-destructive">
                    {node.error}
                  </p>
                ) : null}

                <div className="mt-2 grid gap-3 md:grid-cols-2">
                  <div>
                    <p className="mb-1 text-xs font-medium">Input</p>
                    <Json value={node.input} />
                  </div>
                  <div>
                    <p className="mb-1 text-xs font-medium">Output</p>
                    <Json value={node.output} />
                  </div>
                </div>

                <div className="mt-2 flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    handler <code className="font-mono">{node.handler ?? node.nodeType}</code>
                    {" · "}${(node.costMicroUsd / 1_000_000).toFixed(4)}
                  </span>
                  {node.state === "failed_terminal" || node.state === "timed_out" ? (
                    <RetryNodeButton nodeRunId={node.id} />
                  ) : null}
                </div>
              </details>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-lg font-medium">Transition history</h2>
        <p className="mb-2 text-xs text-muted-foreground">
          Append-only. Who or what changed the state, when, and why — this is the
          audit trail, not a debug log.
        </p>
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs">
              <tr>
                <th className="p-2">At</th>
                <th className="p-2">Scope</th>
                <th className="p-2">Node</th>
                <th className="p-2">From → To</th>
                <th className="p-2">Actor</th>
                <th className="p-2">Reason</th>
              </tr>
            </thead>
            <tbody>
              {transitions.map((transition, index) => (
                <tr key={index} className="border-t">
                  <td className="p-2 text-xs text-muted-foreground">
                    {(transition.at as Date).toISOString().slice(11, 19)}
                  </td>
                  <td className="p-2 text-xs">{transition.scope as string}</td>
                  <td className="p-2 font-mono text-xs">
                    {(transition.nodeVersion as string | null) ?? "—"}
                  </td>
                  <td className="p-2 text-xs">
                    {transition.fromState as string} → {transition.toState as string}
                  </td>
                  <td className="p-2 text-xs">{transition.actor as string}</td>
                  <td className="p-2 text-xs text-muted-foreground">
                    {(transition.reason as string) || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <p className="mt-6 text-xs text-muted-foreground">
        <Link href="/automation/runs" className="underline">
          All runs
        </Link>
        {" · "}
        <Link href={`/automation/workflows/${run.definitionKey}`} className="underline">
          This workflow
        </Link>
      </p>
    </PageShell>
  );
}
