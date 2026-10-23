/**
 * Migration runner. Usage: tsx scripts/migrate.ts up|down|status [--db <url>]
 *
 * Files in db/migrations/NNN_name.sql contain "-- +migrate up" and
 * "-- +migrate down" sections. Applied migrations are tracked in
 * schema_migrations; each migration runs in a transaction.
 * `down` reverts only the most recently APPLIED migration (docs/09: every
 * migration reversible). `status` is read-only: applied vs pending.
 *
 * Also importable: `migrate(direction, url)` runs the same logic in-process,
 * which is how the test suite migrates once per run instead of shelling out
 * per file (tests/global-setup.ts).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

const MIGRATIONS_DIR = join(__dirname, "..", "db", "migrations");
const UP_MARKER = "-- +migrate up";
const DOWN_MARKER = "-- +migrate down";

function parseMigration(file: string): { up: string; down: string } {
  const raw = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
  const upStart = raw.indexOf(UP_MARKER);
  const downStart = raw.indexOf(DOWN_MARKER);
  if (upStart === -1 || downStart === -1 || downStart < upStart) {
    throw new Error(`${file}: missing or misordered up/down markers`);
  }
  return {
    up: raw.slice(upStart + UP_MARKER.length, downStart).trim(),
    down: raw.slice(downStart + DOWN_MARKER.length).trim(),
  };
}

export type MigrateDirection = "up" | "down" | "status";

/**
 * Apply all pending migrations (`up`), revert the most recently applied one
 * (`down`), or report applied/pending (`status`) against `url`. Opens and
 * closes its own single connection; throws on failure. `log` receives the
 * same lines the CLI prints.
 */
/** Session advisory lock key: one migration runner per database at a time.
 * The worker image migrates on boot, so two workers starting together would
 * otherwise race to apply the same file (release 151). */
const MIGRATION_LOCK_KEY = 727_274_151;

export interface MigrateOptions {
  /** Allow a down section to drop tables that still hold rows (release 151
   * guard: every spec-151 down refuses by default when data would be lost). */
  allowDestructiveDown?: boolean;
}

export async function migrate(
  direction: MigrateDirection,
  url: string,
  log: (line: string) => void = console.log,
  options: MigrateOptions = {}
): Promise<void> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    // max: 1 → one connection, so this session lock covers every statement.
    await sql`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
    await sql`create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )`;
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => /^\d{3}_.+\.sql$/.test(f))
      .sort();
    const applied = new Set(
      (await sql`select name from schema_migrations`).map((r) => r.name as string)
    );
    if (direction === "status") {
      // Read-only: what is applied, what is pending — for pre-deploy checks.
      const appliedList = files.filter((f) => applied.has(f));
      const pending = files.filter((f) => !applied.has(f));
      log(`applied: ${appliedList.length} (latest ${appliedList.at(-1) ?? "none"})`);
      log(pending.length === 0 ? "pending: none" : `pending: ${pending.join(", ")}`);
      return;
    }
    if (direction === "up") {
      const pending = files.filter((f) => !applied.has(f));
      if (pending.length === 0) {
        log("Nothing to migrate.");
        return;
      }
      for (const file of pending) {
        const { up } = parseMigration(file);
        await sql.begin(async (tx) => {
          await tx.unsafe(up);
          await tx`insert into schema_migrations (name) values (${file})`;
        });
        log(`applied  ${file}`);
      }
    } else {
      // Roll back the most recently APPLIED migration, not the
      // lexicographically last one. The two differ whenever a branch merges
      // a lower-numbered migration after a higher one has shipped — with a
      // filename sort, `down` would unwind a migration that other applied
      // migrations may depend on (cleanup audit 2026-08-18).
      const [lastApplied] = await sql`
        select name from schema_migrations
        order by applied_at desc, name desc limit 1
      `;
      const last = lastApplied?.name as string | undefined;
      if (!last) {
        log("Nothing to roll back.");
        return;
      }
      if (!files.includes(last)) {
        throw new Error(`Cannot roll back ${last}: its file is missing from ${MIGRATIONS_DIR}.`);
      }
      const { down } = parseMigration(last);
      await sql.begin(async (tx) => {
        if (options.allowDestructiveDown) {
          await tx`select set_config('rf.allow_destructive_down', 'on', true)`;
        }
        await tx.unsafe(down);
        await tx`delete from schema_migrations where name = ${last}`;
      });
      log(`reverted ${last}`);
    }
  } finally {
    await sql`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`.catch(() => undefined);
    await sql.end();
  }
}

async function main(): Promise<void> {
  const direction = process.argv[2];
  if (direction !== "up" && direction !== "down" && direction !== "status") {
    console.error("Usage: tsx scripts/migrate.ts up|down|status [--db <url>] [--allow-destructive-down]");
    process.exit(1);
  }
  const dbFlagIdx = process.argv.indexOf("--db");
  const url =
    dbFlagIdx !== -1 ? process.argv[dbFlagIdx + 1] : process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set (and no --db flag given)");
    process.exit(1);
  }
  await migrate(direction, url, console.log, {
    allowDestructiveDown: process.argv.includes("--allow-destructive-down"),
  });
}

// Only run the CLI when executed directly (tsx/node); importing this module
// (vitest global setup, test helpers) must not trigger a migration — and
// must not load dotenv: tests/setup.ts DELETES provider keys so the suite
// can never spend tokens, and a top-level dotenv.config() here silently
// restored them into every test process that imported the helpers
// (cleanup 2026-08-18 — the suite was making real OpenAI calls).
if (require.main === module) {
  // Lazy: dotenv only for the CLI path, matching the old behavior.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("dotenv").config();
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
