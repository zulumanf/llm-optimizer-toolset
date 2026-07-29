/** Typed error taxonomy per docs/11-coding-standards.md (error handling). */
export type ErrorKind =
  | "validation"
  | "not_found"
  | "conflict"
  | "forbidden"
  | "provider_rate_limit"
  | "provider_auth"
  /** A bounded operation exceeded its declared budget (spec 018 node timeouts). */
  | "timeout"
  | "internal";

export class ClassifiedError extends Error {
  readonly kind: ErrorKind;

  constructor(kind: ErrorKind, message: string) {
    super(message);
    this.name = "ClassifiedError";
    this.kind = kind;
  }
}

export function classify(err: unknown): ClassifiedError {
  if (err instanceof ClassifiedError) return err;
  // Postgres unique_violation → conflict (docs/11: classify at the edge)
  if (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "23505"
  ) {
    return new ClassifiedError("conflict", "A record with this value already exists.");
  }
  const message = err instanceof Error ? err.message : "Unknown error";
  return new ClassifiedError("internal", message);
}
