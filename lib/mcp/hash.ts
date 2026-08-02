/** Canonical JSON hashing for the invocation ledger (spec 033). Pure —
 * unit-testable without a database. */
import { createHash } from "node:crypto";

/** Canonical JSON (recursively sorted keys) so hashes ignore key order. */
export function hashArgs(args: unknown): string {
  return createHash("sha256").update(canonicalize(args)).digest("hex");
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`);
  return `{${entries.join(",")}}`;
}
