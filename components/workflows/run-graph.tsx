/**
 * Live workflow-run graph (spec 018 Part 26).
 *
 * Deliberately a layered list, not a canvas: the operator needs to see what is
 * blocked and why, and a hand-rolled force layout would add a dependency and a
 * failure mode for no operational gain. Graph visualisation is never required
 * for the workflow to run (spec 018 Part 26 closing rule).
 */
import type { NodeRun, WorkflowDefinition } from "@/lib/workflow/types";

const STATE_STYLE: Record<string, string> = {
  succeeded: "border-success/50 bg-success/10",
  running: "border-primary bg-primary/10 animate-pulse",
  failed_terminal: "border-destructive bg-destructive/10",
  timed_out: "border-destructive bg-destructive/10",
  failed_retryable: "border-warning/50 bg-warning/10",
  awaiting_approval: "border-warning bg-warning/10",
  awaiting_verification: "border-warning/50 bg-warning/10",
  skipped: "border-muted bg-muted/30 opacity-60",
  cancelled: "border-muted bg-muted/30 opacity-60",
};

/** Longest-path depth per node — the layer it belongs in. */
function layers(spec: WorkflowDefinition): string[][] {
  const depth = new Map<string, number>();
  const incoming = new Map<string, string[]>();
  for (const edge of spec.edges) {
    incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge.from]);
  }
  const compute = (key: string, seen: Set<string>): number => {
    if (depth.has(key)) return depth.get(key)!;
    if (seen.has(key)) return 0;
    const next = new Set(seen).add(key);
    const parents = incoming.get(key) ?? [];
    const value =
      parents.length === 0 ? 0 : Math.max(...parents.map((p) => compute(p, next) + 1));
    depth.set(key, value);
    return value;
  };
  for (const node of spec.nodes) compute(node.key, new Set());

  const maxDepth = Math.max(0, ...[...depth.values()]);
  const result: string[][] = Array.from({ length: maxDepth + 1 }, () => []);
  for (const node of spec.nodes) {
    result[depth.get(node.key) ?? 0]!.push(node.key);
  }
  return result;
}

export function RunGraph({
  spec,
  nodes,
  criticalPath,
}: {
  spec: WorkflowDefinition;
  nodes: (NodeRun & { durationMs: number | null })[];
  criticalPath: string[];
}) {
  const instancesByKey = new Map<string, typeof nodes>();
  for (const node of nodes) {
    instancesByKey.set(node.nodeKey, [...(instancesByKey.get(node.nodeKey) ?? []), node]);
  }
  const onCriticalPath = new Set(criticalPath);

  return (
    <div className="space-y-2 overflow-x-auto rounded-lg border p-4">
      {layers(spec).map((layer, index) => (
        <div key={index} className="flex flex-wrap items-stretch gap-2">
          {layer.map((nodeKey) => {
            const definition = spec.nodes.find((n) => n.key === nodeKey)!;
            const instances = instancesByKey.get(nodeKey) ?? [];
            const state = aggregateState(instances.map((i) => i.state));
            return (
              <div
                key={nodeKey}
                className={`min-w-48 rounded-md border p-2 text-xs ${STATE_STYLE[state] ?? "border-dashed"} ${
                  onCriticalPath.has(nodeKey) ? "ring-1 ring-foreground/30" : ""
                }`}
                title={definition.description ?? definition.name}
              >
                <p className="font-medium">{definition.name}</p>
                <p className="font-mono text-[10px] text-muted-foreground">
                  {definition.type}
                </p>
                <p className="mt-1 text-[10px] text-muted-foreground">
                  {instances.length === 0
                    ? "not started"
                    : instances.length === 1
                      ? state.replace(/_/g, " ")
                      : `${instances.length} instances · ${state.replace(/_/g, " ")}`}
                  {onCriticalPath.has(nodeKey) && " · critical path"}
                </p>
              </div>
            );
          })}
        </div>
      ))}
      <p className="pt-2 text-[10px] text-muted-foreground">
        Layers are longest-path depth. Nodes in the same row have no dependency
        on each other and run concurrently.
      </p>
    </div>
  );
}

/** The most alarming state among a fan-out's instances is the one to show. */
function aggregateState(states: string[]): string {
  if (states.length === 0) return "pending";
  const priority = [
    "failed_terminal",
    "timed_out",
    "awaiting_approval",
    "awaiting_verification",
    "failed_retryable",
    "running",
    "succeeded",
    "skipped",
    "cancelled",
    "ready",
    "pending",
  ];
  for (const state of priority) {
    if (states.includes(state)) return state;
  }
  return states[0]!;
}
