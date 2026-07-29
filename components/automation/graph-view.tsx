/**
 * Read-only graph visualisation.
 *
 * A layered rendering, not an interactive canvas — and deliberately never
 * required for a workflow to run. Layers come from the longest path to each
 * node, so a reader sees what happens in parallel and where the gates sit.
 *
 * The path to a canvas is short and documented in
 * specs/automation-workflow-library.md: the graph is already data, validation is
 * already a pure function, and the node palette is already a typed registry.
 */
import { Badge } from "@/components/ui/badge";
import type { EdgeDefinition, NodeDefinition } from "@/lib/workflow/types";

const TYPE_STYLE: Record<string, string> = {
  deterministic_task: "border-slate-300 dark:border-slate-700",
  agent_task: "border-violet-400 dark:border-violet-600",
  verification_task: "border-sky-400 dark:border-sky-600",
  integration_task: "border-amber-400 dark:border-amber-600",
  approval_gate: "border-rose-400 dark:border-rose-600",
  evidence_gate: "border-emerald-400 dark:border-emerald-600",
  condition: "border-slate-300 dark:border-slate-700",
  fan_out: "border-slate-400 dark:border-slate-600",
  fan_in: "border-slate-400 dark:border-slate-600",
  terminal_success: "border-emerald-500 dark:border-emerald-600",
  terminal_failure: "border-destructive",
};

/** Longest-path layering: a node sits below every node that must precede it. */
export function layerNodes(
  nodes: NodeDefinition[],
  edges: EdgeDefinition[]
): NodeDefinition[][] {
  const depth = new Map<string, number>();
  const incoming = new Map<string, string[]>();
  for (const edge of edges) {
    incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge.from]);
  }

  // Iterate to a fixed point. Bounded by node count, so a declared loop cannot
  // spin: it simply stops deepening.
  for (let pass = 0; pass < nodes.length + 1; pass += 1) {
    let changed = false;
    for (const node of nodes) {
      const parents = incoming.get(node.key) ?? [];
      const computed =
        parents.length === 0
          ? 0
          : Math.max(...parents.map((parent) => (depth.get(parent) ?? 0) + 1));
      if (computed !== (depth.get(node.key) ?? 0)) {
        depth.set(node.key, computed);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const maxDepth = Math.max(0, ...[...depth.values()]);
  const layers: NodeDefinition[][] = Array.from({ length: maxDepth + 1 }, () => []);
  for (const node of nodes) layers[depth.get(node.key) ?? 0]!.push(node);
  return layers.filter((layer) => layer.length > 0);
}

export function GraphView({
  nodes,
  edges,
  states,
}: {
  nodes: NodeDefinition[];
  edges: EdgeDefinition[];
  /** Node key → current state, when rendering over a live run. */
  states?: Record<string, string>;
}) {
  const layers = layerNodes(nodes, edges);
  const outgoing = new Map<string, EdgeDefinition[]>();
  for (const edge of edges) {
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge]);
  }

  return (
    <div className="overflow-x-auto">
      <ol className="space-y-2">
        {layers.map((layer, index) => (
          <li key={index}>
            <div className="flex items-start gap-2">
              <span className="mt-2 w-8 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                {index + 1}
              </span>
              <div className="flex flex-wrap gap-2">
                {layer.map((node) => {
                  const state = states?.[node.key];
                  const conditional = (outgoing.get(node.key) ?? []).some(
                    (edge) => edge.condition !== undefined
                  );
                  return (
                    <div
                      key={node.key}
                      className={`min-w-[13rem] max-w-xs rounded-lg border-l-4 border bg-card p-2 ${
                        TYPE_STYLE[node.type] ?? "border-slate-300"
                      }`}
                    >
                      <p className="font-mono text-xs">{node.key}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">{node.name}</p>
                      <div className="mt-1 flex flex-wrap gap-1">
                        <Badge variant="outline" className="text-[10px] font-normal">
                          {node.type.replace(/_/g, " ")}
                        </Badge>
                        {node.requiresApproval ||
                        node.type === "approval_gate" ? (
                          <Badge variant="secondary" className="text-[10px] font-normal">
                            human
                          </Badge>
                        ) : null}
                        {node.riskLevel === "high" || node.riskLevel === "critical" ? (
                          <Badge variant="destructive" className="text-[10px] font-normal">
                            {node.riskLevel}
                          </Badge>
                        ) : null}
                        {conditional ? (
                          <Badge variant="outline" className="text-[10px] font-normal">
                            branches
                          </Badge>
                        ) : null}
                        {state ? (
                          <Badge variant="outline" className="text-[10px] font-normal">
                            {state.replace(/_/g, " ")}
                          </Badge>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </li>
        ))}
      </ol>

      <p className="mt-4 text-xs text-muted-foreground">
        Nodes on the same row have no dependency between them and may run
        concurrently. Border colour indicates node category; a{" "}
        <span className="font-medium">human</span> badge marks a durable approval
        wait.
      </p>
    </div>
  );
}
