import postgres from "postgres";
import { getEnv } from "@/lib/env";

/**
 * Single postgres.js client. `transform: postgres.camel` maps snake_case
 * columns to camelCase results (docs/11: query layer maps at the boundary).
 * Cached on globalThis so Next.js dev hot-reload doesn't leak connections.
 */
declare global {
  var __sqlClient: ReturnType<typeof postgres> | undefined;
}

function createClient(): ReturnType<typeof postgres> {
  return postgres(getEnv().DATABASE_URL, {
    transform: postgres.camel,
    onnotice: () => {},
    max: 10,
    // Production sits behind a session-mode pooler with a 15-client cap shared
    // by web + worker (+ operator scripts). Idle connections are released after
    // 30s so a burst in one process cannot pin the pooler for the others
    // (spec 132 production smoke, EMAXCONNSESSION).
    idle_timeout: 30,
    // Every client-side date string is UTC (toISOString), so the session
    // must resolve `current_date` and `::date` in UTC too — on a non-UTC
    // server every freshness window, due date, and health period would
    // silently shift by the offset (cleanup audit 2026-08-04, risk #4).
    connection: { TimeZone: "UTC" },
  });
}

export const sql = globalThis.__sqlClient ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.__sqlClient = sql;
}

export type Sql = typeof sql;
export type { TransactionSql } from "postgres";

/**
 * A dedicated single-connection client for SESSION advisory locks (release
 * 151). Lock holders (job execution, run execution, scheduler tick) keep a
 * session open for minutes; if that session dies, the connection must never
 * return to the shared pool — postgres.js 3.4.x hands a dead pooled
 * connection to the next borrower (ECONNRESET, or an uncatchable TypeError
 * from its own write timer; reproduced in tests/integration/job-fencing).
 * Each lock holder opens one of these and destroys it when done.
 */
export function createLockClient(): ReturnType<typeof postgres> {
  return postgres(getEnv().DATABASE_URL, {
    onnotice: () => {},
    max: 1,
    // Both timers OFF: postgres.js recycles a connection after a random
    // 30–60 min `max_lifetime` (verified in its source), which would end the
    // session and silently release a lock held by a long benchmark run.
    idle_timeout: 0,
    max_lifetime: 0,
    connection: { TimeZone: "UTC", application_name: "rf-lock" },
  });
}

/** Close a lock client without waiting on a dead socket. */
export async function destroyLockClient(client: ReturnType<typeof postgres>): Promise<void> {
  try {
    await client.end({ timeout: 0 });
  } catch {
    // already gone
  }
}
