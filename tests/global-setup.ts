/**
 * B4 (pilot-launch-plan): one suite per test database, enforced.
 *
 * Every integration file does `drop schema public cascade` + migrate in its
 * beforeAll. Two vitest invocations sharing TEST_DATABASE_URL therefore
 * destroy each other's schema mid-flight — dozens of files fail with
 * confusing catalog errors and the operator concludes the suite is flaky
 * (this happened during the 2026-07-31 audit, three concurrent runs).
 *
 * A session-scoped advisory lock held for the whole run turns that into a
 * fast, explicit refusal instead. Unit-only runs (no TEST_DATABASE_URL) are
 * unaffected.
 */
// globalSetup runs before setupFiles, so it must load .env itself — without
// this, TEST_DATABASE_URL is unset here, the guard silently no-ops, and the
// lock protects nothing (exactly how it failed on first implementation).
import * as dotenv from "dotenv";
dotenv.config();

import postgres from "postgres";

// Arbitrary fixed key; the only requirement is that every suite instance
// agrees on it.
const SUITE_LOCK_KEY = 727_274_001;

export default async function globalSetup(): Promise<(() => Promise<void>) | void> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return; // integration files skip themselves; nothing to guard

  const sql = postgres(url, { max: 1 });
  try {
    const [row] = await sql`select pg_try_advisory_lock(${SUITE_LOCK_KEY}) as locked`;
    if (!row?.locked) {
      await sql.end();
      throw new Error(
        "Another test run currently holds the test database " +
          "(TEST_DATABASE_URL). Concurrent suites drop each other's schema " +
          "mid-flight — wait for the other run to finish, or point this one " +
          "at a different database."
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("Another test run")) throw err;
    // The database being unreachable is a different problem with a different
    // message; let the integration files' own beforeAll surface it.
    await sql.end().catch(() => undefined);
    return;
  }

  return async () => {
    // Session lock: released on disconnect anyway, but be explicit.
    await sql`select pg_advisory_unlock(${SUITE_LOCK_KEY})`.catch(() => undefined);
    await sql.end();
  };
}
