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
