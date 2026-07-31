/**
 * Shared bearer-secret check for the cron routes (docs/10).
 *
 * One implementation because the four routes had drifted: weekly-baseline
 * compared with `timingSafeEqual`, the other three with `!==` — a timing
 * side-channel on the exact header an attacker controls. Constant-time or
 * nothing, everywhere.
 *
 * Returns a Response to send when the request is NOT authorized, or null
 * when it is. Fail-closed: no configured secret means 503, never open.
 */
import { timingSafeEqual } from "node:crypto";

export function requireCronSecret(request: Request): Response | null {
  // Read per request, not via getEnv(): the env snapshot is cached at first
  // call, and this secret must be injectable by tests and rotatable without
  // a process restart. (The pre-refactor weekly-baseline route did the same.)
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return Response.json(
      { error: "CRON_SECRET is not configured" },
      { status: 503 }
    );
  }
  const header = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  const equal =
    header.length === expected.length && timingSafeEqual(header, expected);
  if (!equal) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}
