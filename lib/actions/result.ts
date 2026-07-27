/** Discriminated action result crossing the server-action boundary (docs/11). */
import { ClassifiedError, classify, type ErrorKind } from "@/lib/errors";

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { kind: ErrorKind; message: string } };

export function ok<T>(data: T): ActionResult<T> {
  return { ok: true, data };
}

export function fail<T>(err: unknown): ActionResult<T> {
  const classified: ClassifiedError = classify(err);
  return {
    ok: false,
    error: { kind: classified.kind, message: classified.message },
  };
}
