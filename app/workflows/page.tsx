import Link from "next/link";
import { listWorkflowRuns } from "@/db/control-tower";
import { WORKFLOW_TEMPLATES } from "@/lib/workflow/templates";
import { validateGraph } from "@/lib/workflow/graph";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

const STATE_VARIANT: Record<string, "default" | "destructive" | "outline" | "secondary"> = {
  running: "default",
  initializing: "default",
  queued: "outline",
  waiting_for_approval: "secondary",
  waiting_for_dependency: "secondary",
  waiting_for_external_system: "secondary",
  completed: "outline",
  partially_completed: "secondary",
  failed: "destructive",
  cancelled: "outline",
  safely_stopped: "secondary",
  timed_out: "destructive",
};

export default async function WorkflowsPage() {
  const runs = await listWorkflowRuns({ limit: 50 });

  return (
    <div className="mx-auto max-w-6xl p-6">
      <div className="mb-1 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Workflows</h1>
        <Link
          href="/control-tower"
          className="text-sm text-muted-foreground underline hover:text-foreground"
        >
          Control tower
        </Link>
      </div>
      <p className="mb-6 text-sm text-muted-foreground">
        Every process is a versioned directed graph. A run points at the version
        it executed, so a finished run stays reproducible even after the
        template changes.
      </p>

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-medium">Definitions</h2>
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs">
              <tr>
                <th className="p-2">Key</th>
                <th className="p-2">Name</th>
                <th className="p-2">Action type</th>
                <th className="p-2 text-right">Autonomy</th>
                <th className="p-2 text-right">Nodes</th>
                <th className="p-2 text-right">Edges</th>
                <th className="p-2">Graph</th>
              </tr>
            </thead>
            <tbody>
              {WORKFLOW_TEMPLATES.map((template) => {
                const errors = validateGraph(template);
                return (
                  <tr key={template.key} className="border-t">
                    <td className="p-2 font-mono text-xs">{template.key}</td>
                    <td className="p-2">{template.name}</td>
                    <td className="p-2 text-xs text-muted-foreground">{template.actionType}</td>
                    <td className="p-2 text-right tabular-nums">{template.autonomyLevel}</td>
                    <td className="p-2 text-right tabular-nums">{template.nodes.length}</td>
                    <td className="p-2 text-right tabular-nums">{template.edges.length}</td>
                    <td className="p-2">
                      {errors.length === 0 ? (
                        <span className="text-xs text-success">valid</span>
                      ) : (
                        <span className="text-xs text-destructive">
                          {errors.length} problem(s)
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-lg font-medium">Runs</h2>
        {runs.length === 0 ? (
          <div className="rounded-lg border border-dashed p-12 text-center text-sm text-muted-foreground">
            No workflow has run yet. Start one from a client page, or run{" "}
            <code>npm run seed:graph</code> to populate the demo scenario.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left text-xs">
                <tr>
                  <th className="p-2">Workflow</th>
                  <th className="p-2">Client</th>
                  <th className="p-2">State</th>
                  <th className="p-2 text-right">Nodes</th>
                  <th className="p-2 text-right">Cost</th>
                  <th className="p-2">Started</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id} className="border-t">
                    <td className="p-2">
                      <Link href={`/workflows/${run.id}`} className="hover:underline">
                        {run.definitionName}
                      </Link>
                      <span className="ml-1 text-xs text-muted-foreground">v{run.version}</span>
                    </td>
                    <td className="p-2 text-xs text-muted-foreground">
                      {run.projectName ?? "—"}
                    </td>
                    <td className="p-2">
                      <Badge variant={STATE_VARIANT[run.state] ?? "outline"}>
                        {run.state.replace(/_/g, " ")}
                      </Badge>
                      {run.stopReason && (
                        <p className="mt-0.5 text-xs text-muted-foreground">{run.stopReason}</p>
                      )}
                    </td>
                    <td className="p-2 text-right text-xs tabular-nums">
                      {run.nodeCounts.succeeded}✓ {run.nodeCounts.failed}✗{" "}
                      {run.nodeCounts.waiting}⏸
                    </td>
                    <td className="p-2 text-right tabular-nums">
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
    </div>
  );
}
