import { ClassifiedError } from "@/lib/errors";

export function firstZodMessage(error: { issues: { message: string }[] }): string {
  return error.issues[0]?.message ?? "Invalid input.";
}

/** Map Postgres unique_violation to a domain-worded conflict error. */
export function duplicateNameConflict(err: unknown, message: string): unknown {
  if (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "23505"
  ) {
    return new ClassifiedError("conflict", message);
  }
  return err;
}
