/**
 * Path resolution for node configuration.
 *
 * Two things are deliberately separated here, and keeping them separate is the
 * whole point of this module:
 *
 *   **Edges govern execution.** Whether a node runs — and therefore whether a
 *   gate can be bypassed — is decided entirely by the graph's edges and
 *   conditions in `lib/workflow/graph.ts`. Nothing here influences that.
 *
 *   **Paths govern reading.** A node's `inputs` contain only its *direct*
 *   upstream outputs, which is the engine's contract. But a template routinely
 *   needs a value produced further back — a report's approval node needs the
 *   metric section computed four nodes earlier — and threading it forward
 *   through every intermediate node would either bloat every output or, worse,
 *   tempt an author into adding a shortcut edge that lets a node run before its
 *   gate has cleared.
 *
 * So resolution looks in three places, in order:
 *   1. direct upstream outputs (`ctx.inputs`) — a computed value wins;
 *   2. the run's own start input — trigger payloads, periods, parameters;
 *   3. any node in this run that has already SUCCEEDED.
 *
 * Step 3 is a read, never a permission. A node that has not run has no output to
 * read, so a bypassed gate still starves its downstream nodes of data — the
 * failure mode stays safe.
 */
import { sql } from "@/db/client";
import { readPath } from "@/lib/workflow/graph";
import type { NodeContext } from "@/lib/workflow/types";

/**
 * Succeeded node outputs for a run.
 *
 * Deliberately uncached. A tick settles nodes as it goes, so any cache would
 * have to be invalidated on every settle — and a stale read here would mean a
 * node silently working from an earlier version of its own run. The query is one
 * indexed lookup and only happens when both `ctx.inputs` and the run input have
 * already missed, which is the uncommon case.
 */
async function runOutputs(runId: string): Promise<Record<string, unknown>> {
  const rows = await sql`
    select node_key, fan_key, output from node_runs
    where workflow_run_id = ${runId} and state = 'succeeded' and output is not null
    order by finished_at asc
  `;
  const outputs: Record<string, unknown> = {};
  for (const row of rows) {
    const nodeKey = row.nodeKey as string;
    const fanKey = (row.fanKey as string) ?? "";
    const output = row.output as Record<string, unknown>;
    if (fanKey === "") {
      outputs[nodeKey] = output;
    } else {
      // A fanned-out node has one output per key. Expose them keyed, and keep
      // the most recent as the bare value so a template reading the node name
      // gets something rather than nothing.
      const existing = (outputs[nodeKey] as Record<string, unknown>) ?? {};
      existing[fanKey] = output;
      outputs[nodeKey] = existing;
    }
  }
  return outputs;
}

/**
 * Read a dotted path. Returns undefined when nothing has it — callers decide
 * whether that is fatal, because for some nodes an absent value is a safe stop
 * and for others it is a legitimate default.
 */
export async function resolve(ctx: NodeContext, path: string): Promise<unknown> {
  if (path.length === 0) return undefined;

  const fromUpstream = readPath(ctx.inputs, path);
  if (fromUpstream !== undefined && fromUpstream !== null) return fromUpstream;

  const fromInput = readPath(ctx.workflowInput, path);
  if (fromInput !== undefined && fromInput !== null) return fromInput;

  const outputs = await runOutputs(ctx.runId);
  return readPath(outputs, path);
}

/** Read a string, or an empty string when absent. */
export async function resolveString(ctx: NodeContext, path: string): Promise<string> {
  const value = await resolve(ctx, path);
  if (typeof value === "string") return value;
  return value === undefined || value === null ? "" : String(value);
}

/** Read an object, or an empty object when absent. */
export async function resolveObject(
  ctx: NodeContext,
  path: string
): Promise<Record<string, unknown>> {
  const value = await resolve(ctx, path);
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Read an array, or an empty array when absent. */
export async function resolveArray(ctx: NodeContext, path: string): Promise<unknown[]> {
  const value = await resolve(ctx, path);
  return Array.isArray(value) ? value : [];
}

/**
 * Read the first path that yields a value. Lets a template offer a computed
 * value with a raw fallback without the node hard-coding either.
 */
export async function resolveFirst(ctx: NodeContext, paths: string[]): Promise<unknown> {
  for (const path of paths) {
    const value = await resolve(ctx, path);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}
