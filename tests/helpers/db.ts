/**
 * Shared test-database plumbing.
 *
 * The schema is built ONCE per vitest run (tests/global-setup.ts drops
 * `public` and runs every migration in-process). Integration files must not
 * re-migrate — they inherit the schema and are responsible only for the data
 * they create, via their beforeEach truncate lists or `truncateAll`.
 */
import type { Sql } from "@/db/client";
import { migrate } from "../../scripts/migrate";
import { seedTestActors } from "./actors";

/**
 * Rebuild the test schema from zero: drop `public`, re-create it, and apply
 * every migration in-process against TEST_DATABASE_URL. Used by the global
 * setup; individual test files should not need it.
 */
export async function resetTestDb(sql: Sql): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("resetTestDb requires TEST_DATABASE_URL");
  await sql.unsafe("drop schema public cascade; create schema public;");
  // Silent: 80+ "applied" lines per suite run is noise, and failures throw.
  await migrate("up", url, () => undefined);
}

/**
 * Truncate every table in `public` except `schema_migrations`, then re-seed
 * the fixture actors (seedTestActors is idempotent) so every file's
 * hand-written CurrentUser literals keep resolving to real users rows.
 */
export async function truncateAll(sql: Sql): Promise<void> {
  const tables = await sql<{ tablename: string }[]>`
    select tablename from pg_tables
    where schemaname = 'public' and tablename <> 'schema_migrations'
  `;
  if (tables.length > 0) {
    const list = tables.map((t) => `"${t.tablename}"`).join(", ");
    await sql.unsafe(`truncate ${list} cascade`);
  }
  await seedTestActors(sql);
}
