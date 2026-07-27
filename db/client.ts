import postgres from "postgres";
import { getEnv } from "@/lib/env";

/**
 * Single postgres.js client. `transform: postgres.camel` maps snake_case
 * columns to camelCase results (docs/11: query layer maps at the boundary).
 * Cached on globalThis so Next.js dev hot-reload doesn't leak connections.
 */
declare global {
  // eslint-disable-next-line no-var
  var __sqlClient: ReturnType<typeof postgres> | undefined;
}

function createClient(): ReturnType<typeof postgres> {
  return postgres(getEnv().DATABASE_URL, {
    transform: postgres.camel,
    onnotice: () => {},
    max: 10,
  });
}

export const sql = globalThis.__sqlClient ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.__sqlClient = sql;
}

export type Sql = typeof sql;
export type { TransactionSql } from "postgres";
