/**
 * A workflow's detail page: its contract, its graph, and its run history.
 *
 * Everything an operator needs before deciding to run it — including what it
 * needs that is not connected, and what it will stop for.
 */
import { PageHeader, PageShell } from "@/components/layout/page";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AUTOMATION_WORKFLOWS } from "@/lib/automation/workflows";
import { validateAutomationDefinition } from "@/lib/automation/runtime";
import { recentRuns } from "@/lib/automation/metrics";
import { providersFor } from "@/lib/connectors/registry";
import { getConnector } from "@/lib/connectors/registry";
import { listFixtures } from "@/lib/automation/testmode";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { AutomationNav } from "@/components/automation/nav";
import { GraphView } from "@/components/automation/graph-view";
import { StateBadge } from "@/components/automation/state-badge";
import { EmptyState } from "@/components/automation/empty-state";
import { StartRunForm } from "@/components/automation/start-run-form";

export const dynamic = "force-dynamic";

const AUTONOMY_LABEL: Record<number, string> = {
  0: "Manual only — the platform records and supports, a person does the work",
  1: "Assisted — the platform researches and drafts",
  2: "Approval required — the platform prepares, a human releases",
  3: "Autonomous with retrospective review",
  4: "Autonomous by exception",
};

export default async function WorkflowDetailPage({
  params,
}: {
  params: Promise<{ key: string }>;
}) {
  const { key } = await params;
  const workflow = AUTOMATION_WORKFLOWS.find((w) => w.key === key);
  if (!workflow) notFound();

  const [runs, fixtures] = await Promise.all([
    recentRuns({ workflowKey: key, limit: 20 }),
    listFixtures(key),
  ]);
  const errors = validateAutomationDefinition(workflow);

  return (
    <PageShell>
      <PageHeader
        title={workflow.name}
        badge={<Badge variant="outline">v{workflow.version}</Badge>}
        description={
          <>
            <span className="font-mono text-xs">{workflow.key}</span>
            <span className="mt-2 block">{workflow.description}</span>
          </>
        }
      />

      <AutomationNav current="workflows" />

      {errors.length > 0 ? (
        <div className="mb-6 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
          <p className="text-sm font-medium text-destructive">
            This template does not validate and cannot publish:
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">
            {errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <section className="mb-6 grid gap-3 md:grid-cols-3">
        <Card>
          <CardContent className="p-4">
            <h2 className="mb-2 text-sm font-medium">Autonomy &amp; ownership</h2>
            <dl className="space-y-1.5 text-xs">
              <div>
                <dt className="text-muted-foreground">Level</dt>
                <dd>{AUTONOMY_LABEL[workflow.autonomyLevel]}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Risk</dt>
                <dd>{workflow.riskClassification}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Owner</dt>
                <dd>{workflow.owner}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Scope</dt>
                <dd>
                  {workflow.clientScope === "client_required"
                    ? "runs per client"
                    : workflow.clientScope === "platform_only"
                      ? "platform-wide"
                      : "either"}
                </dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <h2 className="mb-2 text-sm font-medium">Limits</h2>
            <dl className="space-y-1.5 text-xs">
              <div>
                <dt className="text-muted-foreground">Cost cap</dt>
                <dd className="tabular-nums">
                  ${(workflow.maxCostMicroUsd / 1_000_000).toFixed(2)} per run
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Max duration</dt>
                <dd className="tabular-nums">{workflow.maxDurationMinutes} min</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Concurrency</dt>
                <dd className="tabular-nums">
                  {workflow.maxConcurrentRuns} run(s), {workflow.maxParallel} parallel nodes
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Retry budget</dt>
                <dd className="tabular-nums">{workflow.retryBudget}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Evaluation suite</dt>
                <dd>{workflow.evaluationSuite ?? "none declared"}</dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <h2 className="mb-2 text-sm font-medium">Required connectors</h2>
            {workflow.requiredConnectors.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                None — this workflow touches no external system.
              </p>
            ) : (
              <ul className="space-y-1 text-xs">
                {workflow.requiredConnectors.map((capability) => {
                  const providers = providersFor(capability);
                  const best = providers.length > 0 ? getConnector(providers[0]!) : null;
                  return (
                    <li key={capability} className="flex items-baseline justify-between gap-2">
                      <span className="font-mono">{capability}</span>
                      {best === null ? (
                        <Badge variant="destructive">no adapter</Badge>
                      ) : (
                        <Badge variant={best.status === "verified" ? "outline" : "secondary"}>
                          {best.status === "verified" ? "verified" : "unverified"}
                        </Badge>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {workflow.requiredApprovals.length > 0 ? (
              <>
                <h3 className="mt-3 mb-1 text-xs font-medium">Required approvals</h3>
                <ul className="space-y-0.5 text-xs text-muted-foreground">
                  {workflow.requiredApprovals.map((approval) => (
                    <li key={approval} className="font-mono">
                      {approval}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </CardContent>
        </Card>
      </section>

      <section className="mb-6">
        <h2 className="mb-2 text-lg font-medium">Triggers</h2>
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs">
              <tr>
                <th className="p-2">Kind</th>
                <th className="p-2">Detail</th>
                <th className="p-2">Why unattended is safe</th>
              </tr>
            </thead>
            <tbody>
              {workflow.triggers.map((trigger, index) => (
                <tr key={index} className="border-t align-top">
                  <td className="p-2">
                    <Badge variant="outline">{trigger.kind}</Badge>
                  </td>
                  <td className="p-2 text-xs">
                    {trigger.kind === "schedule" ? (
                      <span className="font-mono">
                        {trigger.cron} ({trigger.timezone ?? "UTC"})
                      </span>
                    ) : trigger.kind === "domain_event" ? (
                      <span className="font-mono">{trigger.eventType}</span>
                    ) : trigger.kind === "threshold" ? (
                      <span className="font-mono">
                        {trigger.metricKey} {trigger.comparison} {trigger.thresholdValue}
                      </span>
                    ) : trigger.kind === "webhook" ? (
                      <span className="font-mono">
                        {trigger.provider} → {trigger.eventType}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">operator-initiated</span>
                    )}
                    <p className="mt-0.5 text-muted-foreground">{trigger.description}</p>
                  </td>
                  <td className="p-2 max-w-md text-xs text-muted-foreground">
                    {trigger.kind === "domain_event" ? trigger.autonomyNote : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mb-6">
        <h2 className="mb-2 text-lg font-medium">Acceptance criteria</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          {(workflow.acceptanceCriteria ?? []).map((criterion) => (
            <li key={criterion}>{criterion}</li>
          ))}
        </ul>
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-medium">Graph</h2>
        <GraphView nodes={workflow.nodes} edges={workflow.edges} />
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-medium">Run in test mode</h2>
        <StartRunForm
          workflowKey={workflow.key}
          clientScope={workflow.clientScope}
          fixtureNames={fixtures.map((f) => f.name)}
        />
      </section>

      <section>
        <h2 className="mb-2 text-lg font-medium">Run history</h2>
        {runs.length === 0 ? (
          <EmptyState
            title="This workflow has not run yet"
            body="Start a test run above, or wait for its trigger to fire. A test run cannot send, publish, or invoice — it records what it would have done instead."
          />
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left text-xs">
                <tr>
                  <th className="p-2">Run</th>
                  <th className="p-2">Mode</th>
                  <th className="p-2">State</th>
                  <th className="p-2">Client</th>
                  <th className="p-2 text-right">Nodes</th>
                  <th className="p-2 text-right">Approvals</th>
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
                    <td className="p-2 text-xs">
                      {run.mode === "test" ? <Badge variant="outline">test</Badge> : "live"}
                    </td>
                    <td className="p-2">
                      <StateBadge state={run.state} />
                    </td>
                    <td className="p-2 text-xs text-muted-foreground">
                      {run.projectName ?? "platform"}
                    </td>
                    <td className="p-2 text-right tabular-nums text-xs">{run.nodeCount}</td>
                    <td className="p-2 text-right tabular-nums text-xs">
                      {run.pendingApprovals}
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
    </PageShell>
  );
}
