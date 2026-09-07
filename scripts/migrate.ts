/**
 * Migration runner. Usage: tsx scripts/migrate.ts up|down [--db <url>]
 *
 * Files in db/migrations/NNN_name.sql contain "-- +migrate up" and
 * "-- +migrate down" sections. Applied migrations are tracked in
 * schema_migrations; each migration runs in a transaction.
 * `down` reverts only the most recent applied migration (docs/09: every
 * migration reversible).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import * as dotenv from "dotenv";

dotenv.config();

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

async function main(): Promise<void> {
  const direction = process.argv[2];
  if (direction !== "up" && direction !== "down" && direction !== "status") {
    console.error("Usage: tsx scripts/migrate.ts up|down|status");
    process.exit(1);
  }
  const dbFlagIdx = process.argv.indexOf("--db");
  const url =
    dbFlagIdx !== -1 ? process.argv[dbFlagIdx + 1] : process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set (and no --db flag given)");
    process.exit(1);
  }

  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
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
      console.log(`applied: ${appliedList.length} (latest ${appliedList.at(-1) ?? "none"})`);
      console.log(pending.length === 0 ? "pending: none" : `pending: ${pending.join(", ")}`);
      return;
    }
    if (direction === "up") {
      const pending = files.filter((f) => !applied.has(f));
      if (pending.length === 0) {
        console.log("Nothing to migrate.");
        return;
      }
      for (const file of pending) {
        const { up } = parseMigration(file);
        await sql.begin(async (tx) => {
          await tx.unsafe(up);
          await tx`insert into schema_migrations (name) values (${file})`;
        });
        console.log(`applied  ${file}`);
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
        console.log("Nothing to roll back.");
        return;
      }
      if (!files.includes(last)) {
        console.error(
          `Cannot roll back ${last}: its file is missing from ${MIGRATIONS_DIR}.`
        );
        process.exit(1);
      }
      const { down } = parseMigration(last);
      await sql.begin(async (tx) => {
        await tx.unsafe(down);
        await tx`delete from schema_migrations where name = ${last}`;
      });
      console.log(`reverted ${last}`);
    }
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
