/**
 * Pure graph algebra (spec 018). No database, no clock, no randomness — every
 * function here is a total function of its arguments, which is why the whole
 * dependency model can be unit-tested without a Postgres.
 *
 * The engine calls into this module for every decision that is structural
 * ("is this node ready?") and handles nothing structural itself.
 */
import type {
  EdgeCondition,
  EdgeDefinition,
  NodeDefinition,
  NodeState,
  WorkflowDefinition,
} from "@/lib/workflow/types";
import { SETTLED_NODE_STATES } from "@/lib/workflow/types";

export const MAX_FAN_OUT = 500;

export interface GraphError {
  code:
    | "unknown_node"
    | "duplicate_node"
    | "no_entry"
    | "no_terminal"
    | "unreachable"
    | "undeclared_cycle"
    | "missing_handler"
    | "invalid_fan_in"
    | "invalid_loop";
  message: string;
}

function nodeMap(nodes: NodeDefinition[]): Map<string, NodeDefinition> {
  return new Map(nodes.map((n) => [n.key, n]));
}

/**
 * Nodes with no incoming edges — where execution begins.
 *
 * A declared rework loop's closing edge does NOT count as incoming. Otherwise
 * a draft → review → draft graph has no entry node at all and every node looks
 * unreachable, which is nonsense: the loop is a way back, not a way in.
 */
export function entryNodes(def: WorkflowDefinition): NodeDefinition[] {
  const hasIncoming = new Set(def.edges.filter((e) => !e.loop).map((e) => e.to));
  return def.nodes.filter((n) => !hasIncoming.has(n.key));
}

/**
 * Depth-first cycle detection. A cycle is an error *unless* every edge that
 * closes it declares a bounded rework loop — bounded loops are a legitimate
 * pattern (draft → review → revise → review) and stay visible in the graph.
 */
export function findUndeclaredCycles(def: WorkflowDefinition): string[][] {
  const outgoing = new Map<string, EdgeDefinition[]>();
  for (const edge of def.edges) {
    const list = outgoing.get(edge.from) ?? [];
    list.push(edge);
    outgoing.set(edge.from, list);
  }

  const cycles: string[][] = [];
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  const visit = (key: string): void => {
    state.set(key, "visiting");
    stack.push(key);
    for (const edge of outgoing.get(key) ?? []) {
      if (edge.loop) continue; // declared, bounded — not a defect
      const status = state.get(edge.to);
      if (status === "visiting") {
        const start = stack.indexOf(edge.to);
        cycles.push([...stack.slice(start), edge.to]);
      } else if (status !== "done") {
        visit(edge.to);
      }
    }
    stack.pop();
    state.set(key, "done");
  };

  for (const node of def.nodes) {
    if (!state.has(node.key)) visit(node.key);
  }
  return cycles;
}

/** Every node reachable from an entry node. */
export function reachableNodes(def: WorkflowDefinition): Set<string> {
  const outgoing = new Map<string, string[]>();
  for (const edge of def.edges) {
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
  }
  const seen = new Set<string>();
  const queue = entryNodes(def).map((n) => n.key);
  while (queue.length > 0) {
    const key = queue.shift()!;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const next of outgoing.get(key) ?? []) queue.push(next);
  }
  return seen;
}

/** Node types that must name a registered handler. */
const HANDLER_REQUIRED = new Set([
  "deterministic_task",
  "agent_task",
  "integration_task",
  "verification_task",
  "evidence_gate",
  "fan_out",
  "notification",
  "condition",
]);

/**
 * Full structural validation. Returns every problem rather than the first —
 * a template author fixing a graph wants the whole list.
 */
export function validateGraph(def: WorkflowDefinition): GraphError[] {
  const errors: GraphError[] = [];
  const nodes = nodeMap(def.nodes);

  if (nodes.size !== def.nodes.length) {
    const seen = new Set<string>();
    for (const node of def.nodes) {
      if (seen.has(node.key)) {
        errors.push({ code: "duplicate_node", message: `Duplicate node key "${node.key}".` });
      }
      seen.add(node.key);
    }
  }

  for (const edge of def.edges) {
    if (!nodes.has(edge.from)) {
      errors.push({ code: "unknown_node", message: `Edge source "${edge.from}" is not a node.` });
    }
    if (!nodes.has(edge.to)) {
      errors.push({ code: "unknown_node", message: `Edge target "${edge.to}" is not a node.` });
    }
    if (edge.loop && edge.loop.maxIterations < 1) {
      errors.push({
        code: "invalid_loop",
        message: `Loop edge ${edge.from}→${edge.to} must allow at least one iteration.`,
      });
    }
  }

  if (entryNodes(def).length === 0) {
    errors.push({ code: "no_entry", message: "Graph has no entry node (every node has an incoming edge)." });
  }

  const terminals = def.nodes.filter(
    (n) => n.type === "terminal_success" || n.type === "terminal_failure"
  );
  if (terminals.length === 0) {
    errors.push({ code: "no_terminal", message: "Graph has no terminal node." });
  }

  const reachable = reachableNodes(def);
  for (const node of def.nodes) {
    if (!reachable.has(node.key)) {
      errors.push({ code: "unreachable", message: `Node "${node.key}" is unreachable from any entry node.` });
    }
    if (HANDLER_REQUIRED.has(node.type) && !node.handler) {
      errors.push({
        code: "missing_handler",
        message: `Node "${node.key}" (${node.type}) must name a handler.`,
      });
    }
    // A fan-in exists to join branches; one input means the author wanted a
    // plain edge and the graph is lying about its shape.
    if (node.type === "fan_in") {
      const incoming = def.edges.filter((e) => e.to === node.key);
      if (incoming.length === 0) {
        errors.push({ code: "invalid_fan_in", message: `Fan-in "${node.key}" has no incoming edges.` });
      }
    }
  }

  for (const cycle of findUndeclaredCycles(def)) {
    errors.push({
      code: "undeclared_cycle",
      message: `Undeclared cycle: ${cycle.join(" → ")}. Declare a bounded loop on the closing edge if this is deliberate.`,
    });
  }

  return errors;
}

// ------------------------------------------------------------- ready set

/** Read a dotted path out of a node output. */
export function readPath(source: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (acc, part) =>
        acc && typeof acc === "object" ? (acc as Record<string, unknown>)[part] : undefined,
      source
    );
}

export function evaluateCondition(
  condition: EdgeCondition | undefined,
  output: Record<string, unknown> | null,
  state: NodeState
): boolean {
  if (!condition || condition.kind === "always") return true;
  switch (condition.kind) {
    case "node_state":
      return state === condition.state;
    case "output_equals":
      return readPath(output, condition.path) === condition.value;
    case "output_gte": {
      const value = readPath(output, condition.path);
      return typeof value === "number" && value >= condition.value;
    }
    case "output_lt": {
      const value = readPath(output, condition.path);
      return typeof value === "number" && value < condition.value;
    }
    case "output_truthy":
      return Boolean(readPath(output, condition.path));
  }
}

/** The state of one node instance, as the ready-set computation needs it. */
export interface InstanceState {
  nodeKey: string;
  fanKey: string;
  state: NodeState;
  output: Record<string, unknown> | null;
  /**
   * True when a `failed_retryable` instance's backoff has elapsed. The clock
   * lives in the engine so this module stays a pure function; without it a
   * retryable node would never be offered again and the attempt budget would
   * be unreachable.
   */
  retryEligible?: boolean;
}

export interface ReadyInstance {
  nodeKey: string;
  fanKey: string;
  /** Upstream outputs, keyed by source node key. */
  inputs: Record<string, unknown>;
}

/**
 * Which node instances can run right now.
 *
 * The rules, stated once:
 *  - A node with no incoming edges is ready at start.
 *  - A node is ready when every REQUIRED incoming edge is satisfied: its
 *    source settled AND its condition holds. An optional edge never blocks.
 *  - A settled or running instance is never re-offered.
 *  - Fan keys propagate: a node downstream of a fan-out runs once per key.
 *    A fan_in collapses back to the singleton key ''.
 */
export function computeReady(
  def: WorkflowDefinition,
  instances: InstanceState[],
  fanKeysByNode: Map<string, string[]>
): ReadyInstance[] {
  const byNode = new Map<string, InstanceState[]>();
  for (const instance of instances) {
    byNode.set(instance.nodeKey, [...(byNode.get(instance.nodeKey) ?? []), instance]);
  }
  const settled = (s: NodeState): boolean => SETTLED_NODE_STATES.includes(s);
  const ready: ReadyInstance[] = [];

  for (const node of def.nodes) {
    const incoming = def.edges.filter((e) => e.to === node.key);
    // Which fan keys should this node run for?
    const keys = fanKeysByNode.get(node.key) ?? [""];
    const existing = byNode.get(node.key) ?? [];

    for (const fanKey of keys) {
      // Offerable: never started, still pending, or a retryable failure whose
      // backoff has elapsed. Anything else is running or settled.
      const instance = existing.find((i) => i.fanKey === fanKey);
      if (
        instance &&
        instance.state !== "pending" &&
        !(instance.state === "failed_retryable" && instance.retryEligible === true)
      ) {
        continue;
      }

      if (incoming.length === 0) {
        ready.push({ nodeKey: node.key, fanKey, inputs: {} });
        continue;
      }

      const inputs: Record<string, unknown> = {};
      let blocked = false;
      // A node with incoming edges needs at least ONE of them satisfied.
      // Without this, a node reachable only by an optional error-routing edge
      // would fire immediately — before its source has even run — because
      // "not required" would otherwise mean "not waited for".
      let satisfied = 0;

      for (const edge of incoming) {
        const required = edge.required !== false;
        const sources = (byNode.get(edge.from) ?? []).filter(
          // A fan_in gathers every key from upstream; anything else matches
          // its own key (or the singleton key, for a node above the fan-out).
          (i) => node.type === "fan_in" || i.fanKey === fanKey || i.fanKey === ""
        );
        if (sources.length === 0) {
          if (required) blocked = true;
          continue;
        }
        const unsettled = sources.filter((i) => !settled(i.state));
        if (unsettled.length > 0) {
          if (required) blocked = true;
          continue;
        }
        // Without an explicit condition, an edge means "B needs A's output".
        // A source that failed, timed out, or was cancelled has no output, so
        // it blocks its target — settled is not the same as succeeded. An
        // error-routing edge says so explicitly with a `node_state` condition.
        // A fan_in is the exception: it must receive the failed branches too,
        // because disclosing what did not arrive is its entire job.
        const passing = sources.filter((i) =>
          edge.condition
            ? evaluateCondition(edge.condition, i.output, i.state)
            : node.type === "fan_in" || i.state === "succeeded" || i.state === "skipped"
        );
        if (passing.length === 0) {
          // Nothing satisfied the edge: a required edge blocks unless it is
          // explicitly allowed to skip its target.
          if (required && edge.onFailure !== "skip") blocked = true;
          continue;
        }
        satisfied += 1;
        inputs[edge.from] =
          node.type === "fan_in"
            ? passing.map((i) => ({ fanKey: i.fanKey, output: i.output }))
            : (passing[0]!.output ?? {});
      }

      if (!blocked && satisfied > 0) ready.push({ nodeKey: node.key, fanKey, inputs });
    }
  }

  return ready;
}

// ------------------------------------------------------- critical path

export interface TimedInstance {
  nodeKey: string;
  fanKey: string;
  durationMs: number;
}

/**
 * Longest-duration path through the settled graph. Fan-out siblings run in
 * parallel, so a node's cost is its slowest instance — that is the wall-clock
 * the operator actually waited.
 */
export function criticalPath(
  def: WorkflowDefinition,
  timings: TimedInstance[]
): { path: string[]; durationMs: number } {
  const slowest = new Map<string, number>();
  for (const t of timings) {
    slowest.set(t.nodeKey, Math.max(slowest.get(t.nodeKey) ?? 0, t.durationMs));
  }
  const incoming = new Map<string, string[]>();
  for (const edge of def.edges) {
    incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge.from]);
  }

  const memo = new Map<string, { path: string[]; durationMs: number }>();
  const best = (key: string, seen: Set<string>): { path: string[]; durationMs: number } => {
    const cached = memo.get(key);
    if (cached) return cached;
    if (seen.has(key)) return { path: [], durationMs: 0 }; // bounded loop guard
    const own = slowest.get(key);
    if (own === undefined) return { path: [], durationMs: 0 }; // never ran
    const nextSeen = new Set(seen).add(key);
    let bestPrev: { path: string[]; durationMs: number } = { path: [], durationMs: 0 };
    for (const from of incoming.get(key) ?? []) {
      const candidate = best(from, nextSeen);
      if (candidate.durationMs > bestPrev.durationMs) bestPrev = candidate;
    }
    const result = {
      path: [...bestPrev.path, key],
      durationMs: bestPrev.durationMs + own,
    };
    memo.set(key, result);
    return result;
  };

  let overall: { path: string[]; durationMs: number } = { path: [], durationMs: 0 };
  for (const node of def.nodes) {
    const candidate = best(node.key, new Set());
    if (candidate.durationMs > overall.durationMs) overall = candidate;
  }
  return overall;
}

/**
 * Fraction of total node time that ran off the critical path — how much of
 * this workflow benefited from being a graph rather than a list.
 */
export function parallelizableShare(
  totalNodeMs: number,
  criticalPathMs: number
): number {
  if (totalNodeMs <= 0) return 0;
  return Math.max(0, Math.min(1, (totalNodeMs - criticalPathMs) / totalNodeMs));
}
