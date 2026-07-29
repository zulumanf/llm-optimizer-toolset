/**
 * Node handler registry (spec 018).
 *
 * A handler does one unit of work and returns a NodeResult. It receives no
 * transaction and no database handle — the engine performs every write. That
 * is the structural reason an agent in this platform cannot mutate protected
 * state: there is no code path from a handler to a write.
 *
 * Built-in handlers cover the node types whose semantics belong to the engine
 * (fan-in, approval, terminals, delay). Templates register the rest by name.
 */
import { ClassifiedError } from "@/lib/errors";
import type { NodeContext, NodeHandler, NodeResult } from "@/lib/workflow/types";

const handlers = new Map<string, NodeHandler>();

export function registerHandler(name: string, handler: NodeHandler): void {
  handlers.set(name, handler);
}

export function registerHandlers(entries: Record<string, NodeHandler>): void {
  for (const [name, handler] of Object.entries(entries)) registerHandler(name, handler);
}

export function getHandler(name: string): NodeHandler {
  const handler = handlers.get(name);
  if (!handler) {
    throw new ClassifiedError(
      "internal",
      `No workflow handler registered for "${name}". Register it before the workflow runs.`
    );
  }
  return handler;
}

export function hasHandler(name: string): boolean {
  return handlers.has(name);
}

/** Test seam — clears everything except the built-ins. */
export function resetHandlers(): void {
  handlers.clear();
  registerBuiltins();
}

// -------------------------------------------------------------- built-ins

/**
 * Fan-in. Its whole job is to disclose what arrived: how many upstream
 * branches succeeded, how many did not, and whether the result is partial.
 * A fan-in that silently proceeds on whatever showed up is the undisclosed-
 * partial-sample failure this platform exists to prevent.
 */
const fanIn: NodeHandler = async (ctx: NodeContext): Promise<NodeResult> => {
  const branches: { fanKey: string; output: unknown }[] = [];
  for (const value of Object.values(ctx.inputs)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === "object" && "fanKey" in item) {
          branches.push(item as { fanKey: string; output: unknown });
        }
      }
    }
  }
  const failed = branches.filter(
    (b) => b.output === null || (b.output as { ok?: boolean })?.ok === false
  );
  const minimum = Number(ctx.config.minimumBranches ?? 0);
  const completed = branches.length - failed.length;

  if (minimum > 0 && completed < minimum) {
    return {
      outcome: "safe_stop",
      reason: `fan-in requires ${minimum} completed branches; only ${completed} of ${branches.length} succeeded`,
      output: { completed, failed: failed.length, total: branches.length, partial: true },
    };
  }
  return {
    outcome: "succeeded",
    output: {
      completed,
      failed: failed.length,
      total: branches.length,
      partial: failed.length > 0,
      partialDisclosed: true,
      branches: branches.map((b) => b.fanKey),
    },
  };
};

/**
 * Approval gate. It never decides — it parks and waits for a signal. The
 * engine turns this into an approval row and a durable wait state.
 */
const approvalGate: NodeHandler = async (ctx: NodeContext): Promise<NodeResult> => {
  const summary =
    (ctx.config.summary as string) ?? `${ctx.node.name} requires a human decision`;
  return {
    outcome: "awaiting_approval",
    reason: summary,
    output: { requested: true, upstream: ctx.inputs },
  };
};

const terminalSuccess: NodeHandler = async (ctx): Promise<NodeResult> => ({
  outcome: "succeeded",
  output: { terminal: "success", summary: ctx.inputs },
});

const terminalFailure: NodeHandler = async (ctx): Promise<NodeResult> => ({
  outcome: "succeeded",
  output: { terminal: "failure", summary: ctx.inputs },
});

/** A manual task is prepared by the platform and performed by a person. */
const manualTask: NodeHandler = async (ctx): Promise<NodeResult> => ({
  outcome: "awaiting_approval",
  reason: (ctx.config.instruction as string) ?? `${ctx.node.name} must be done by a person`,
  output: { manual: true },
});

const delay: NodeHandler = async (ctx): Promise<NodeResult> => ({
  outcome: "succeeded",
  output: { delayedSeconds: Number(ctx.config.seconds ?? 0) },
});

export function registerBuiltins(): void {
  registerHandlers({
    fan_in: fanIn,
    approval_gate: approvalGate,
    terminal_success: terminalSuccess,
    terminal_failure: terminalFailure,
    manual_task: manualTask,
    delay,
    timer: delay,
  });
}

registerBuiltins();
