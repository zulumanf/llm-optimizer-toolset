/**
 * The workflow template gallery.
 *
 * Shows what each workflow does, what it needs, and where it stops for a human.
 * Validation runs on render, so a template that would fail at 3am fails visibly
 * here instead.
 */
import Link from "next/link";
import { AUTOMATION_WORKFLOWS } from "@/lib/automation/workflows";
import { validateAutomationDefinition } from "@/lib/automation/runtime";
import { workflowMetrics } from "@/lib/automation/metrics";
import { Badge } from "@/components/ui/badge";
import { AutomationNav } from "@/components/automation/nav";

export const dynamic = "force-dynamic";

const AUTONOMY_LABEL: Record<number, string> = {
  0: "manual only",
  1: "assisted",
  2: "approval required",
  3: "autonomous, reviewed after",
  4: "autonomous by exception",
};

const DOMAIN_ORDER = [
  "revenue",
  "delivery",
  "authority",
  "reputation",
  "intelligence",
  "operations",
] as const;

export default async function AutomationWorkflowsPage() {
  const metrics = await workflowMetrics();
  const metricsByKey = new Map(metrics.map((m) => [m.workflowKey, m]));

  const byDomain = DOMAIN_ORDER.map((domain) => ({
    domain,
    workflows: AUTOMATION_WORKFLOWS.filter((w) => w.domain === domain),
  })).filter((group) => group.workflows.length > 0);

  const invalid = AUTOMATION_WORKFLOWS.filter(
    (w) => validateAutomationDefinition(w).length > 0
  );

  return (
    <div className="mx-auto max-w-7xl p-6">
      <h1 className="text-2xl font-semibold">Workflow templates</h1>
      <p className="mt-1 mb-4 text-sm text-muted-foreground">
        {AUTOMATION_WORKFLOWS.length} versioned definitions. A run points at the
        version it executed, so a finished run stays reproducible after the
        template changes.
      </p>

      <AutomationNav current="workflows" />

      {invalid.length > 0 ? (
        <div className="mb-6 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
          <p className="text-sm font-medium text-destructive">
            {invalid.length} template(s) fail validation and will not publish:
          </p>
          <ul className="mt-2 space-y-1 text-xs">
            {invalid.map((workflow) => (
              <li key={workflow.key}>
                <span className="font-mono">{workflow.key}</span>:{" "}
                {validateAutomationDefinition(workflow).join(" ")}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {byDomain.map((group) => (
        <section key={group.domain} className="mb-8">
          <h2 className="mb-2 text-lg font-medium capitalize">{group.domain}</h2>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left text-xs">
                <tr>
                  <th className="p-2">Workflow</th>
                  <th className="p-2">Autonomy</th>
                  <th className="p-2">Risk</th>
                  <th className="p-2">Triggers</th>
                  <th className="p-2">Needs</th>
                  <th className="p-2 text-right">Nodes</th>
                  <th className="p-2 text-right">Runs</th>
                  <th className="p-2 text-right">Outcomes</th>
                  <th className="p-2 text-right">Manual touch</th>
                </tr>
              </thead>
              <tbody>
                {group.workflows.map((workflow) => {
                  const metric = metricsByKey.get(workflow.key);
                  return (
                    <tr key={workflow.key} className="border-t align-top">
                      <td className="p-2">
                        <Link
                          href={`/automation/workflows/${workflow.key}`}
                          className="font-mono text-xs underline"
                        >
                          {workflow.key}
                        </Link>
                        <p className="mt-0.5 max-w-md text-xs text-muted-foreground">
                          {workflow.name}
                        </p>
                      </td>
                      <td className="p-2 text-xs">
                        <span className="tabular-nums font-medium">
                          {workflow.autonomyLevel}
                        </span>{" "}
                        <span className="text-muted-foreground">
                          {AUTONOMY_LABEL[workflow.autonomyLevel]}
                        </span>
                      </td>
                      <td className="p-2">
                        <Badge
                          variant={
                            workflow.riskClassification === "high" ||
                            workflow.riskClassification === "critical"
                              ? "destructive"
                              : "outline"
                          }
                        >
                          {workflow.riskClassification}
                        </Badge>
                      </td>
                      <td className="p-2 text-xs text-muted-foreground">
                        {workflow.triggers.map((t) => t.kind).join(", ")}
                      </td>
                      <td className="p-2 text-xs text-muted-foreground">
                        {workflow.requiredConnectors.length === 0
                          ? "no connectors"
                          : `${workflow.requiredConnectors.length} capabilit${
                              workflow.requiredConnectors.length === 1 ? "y" : "ies"
                            }`}
                        {workflow.requiredApprovals.length > 0 ? (
                          <span className="block">
                            {workflow.requiredApprovals.length} approval(s)
                          </span>
                        ) : null}
                      </td>
                      <td className="p-2 text-right tabular-nums text-xs">
                        {workflow.nodes.length}
                      </td>
                      <td className="p-2 text-right tabular-nums text-xs">
                        {metric?.runs ?? 0}
                        {metric && metric.testRuns > 0 ? (
                          <span className="text-muted-foreground"> +{metric.testRuns}t</span>
                        ) : null}
                      </td>
                      <td className="p-2 text-right tabular-nums text-xs">
                        {metric === undefined || metric.runs === 0 ? (
                          "—"
                        ) : (
                          <span title="completed · safe-stopped · failed">
                            {Math.round(metric.completionRate * 100)}% ·{" "}
                            {Math.round(metric.safeStopRate * 100)}% ·{" "}
                            <span
                              className={
                                metric.failureRate > 0 ? "text-destructive" : undefined
                              }
                            >
                              {Math.round(metric.failureRate * 100)}%
                            </span>
                          </span>
                        )}
                      </td>
                      <td className="p-2 text-right tabular-nums text-xs">
                        {metric === undefined || metric.runs === 0
                          ? "—"
                          : `${Math.round(metric.manualInterventionRate * 100)}%`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ))}

      <p className="text-xs text-muted-foreground">
        &ldquo;Outcomes&rdquo; is completed · safe-stopped · failed as a share of
        live runs. &ldquo;Manual touch&rdquo; is the share of live runs where a
        human had to act on a node. Together they say whether the automation is
        actually helping — a run count on its own does not.
      </p>
    </div>
  );
}
