/**
 * Subscription filter evaluation. Pure, no I/O, exhaustively unit-tested.
 *
 * Filters are data, not expressions. That is not stylistic: a filter that is
 * data can be stored, diffed, shown in the UI and reasoned about without an
 * `eval` in the request path. It is the same decision spec 018 made for edge
 * conditions, and the two evaluators are deliberately shaped alike.
 */
import type { EventFilter } from "@/lib/events/types";

/** Read a dotted path out of a payload. Missing segments yield undefined. */
export function readPath(source: Record<string, unknown>, path: string): unknown {
  let current: unknown = source;
  for (const segment of path.split(".")) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function matchesFilter(
  filter: EventFilter,
  payload: Record<string, unknown>
): boolean {
  switch (filter.kind) {
    case "always":
      return true;
    case "payload_equals":
      return readPath(payload, filter.path) === filter.value;
    case "payload_gte": {
      const value = readPath(payload, filter.path);
      return typeof value === "number" && Number.isFinite(value) && value >= filter.value;
    }
    case "payload_lt": {
      const value = readPath(payload, filter.path);
      return typeof value === "number" && Number.isFinite(value) && value < filter.value;
    }
    case "payload_truthy":
      return Boolean(readPath(payload, filter.path));
    default: {
      // Exhaustiveness: an unknown filter kind never matches. Failing closed is
      // the only safe default for something that decides whether work starts.
      const _exhaustive: never = filter;
      void _exhaustive;
      return false;
    }
  }
}

/**
 * Render an idempotency template. Supported placeholders are a closed set —
 * `{{event.id}}`, `{{event.type}}`, `{{event.projectId}}`, and
 * `{{payload.<path>}}`. An unresolved placeholder is an error, not an empty
 * string: an idempotency key with a hole in it collapses unrelated runs.
 */
export function renderIdempotencyKey(
  template: string,
  event: { id: string; type: string; projectId: string | null; payload: Record<string, unknown> }
): string {
  const rendered = template.replace(/\{\{([^}]+)\}\}/g, (_match, rawExpr: string) => {
    const expr = rawExpr.trim();
    if (expr === "event.id") return event.id;
    if (expr === "event.type") return event.type;
    if (expr === "event.projectId") return event.projectId ?? "platform";
    if (expr.startsWith("payload.")) {
      const value = readPath(event.payload, expr.slice("payload.".length));
      if (value === undefined || value === null) {
        throw new Error(`Idempotency template references missing value "${expr}"`);
      }
      return String(value);
    }
    throw new Error(`Unsupported idempotency placeholder "${expr}"`);
  });
  if (rendered.length === 0) {
    throw new Error("Idempotency template rendered to an empty key");
  }
  return rendered.slice(0, 200);
}
