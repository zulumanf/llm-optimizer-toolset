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
 * Truncate every table in `public` except `schema_migrations`, then replay
 * the migration-seeded rows the schema is never valid without: the dev
 * admin (025), the system user (037), the two active weight sets (045/069 —
 * the scorers fail loudly without them, and a prior file may have left them
 * deactivated or replaced), and the fixture actors. Per-file re-migration
 * used to restore all of this invisibly; now it is explicit.
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
  // Migration-seeded users (025 dev admin, 037 system user) — verbatim.
  await sql`
    insert into users (id, email, name, role)
    values ('00000000-0000-4000-8000-000000000001', 'dev@avos.local', 'Dev User', 'admin')
    on conflict (id) do nothing
  `;
  await sql`
    insert into users (id, email, name, role, active)
    values ('00000000-0000-4000-a000-000000000001', 'system@avos.internal',
      'AI Visibility OS', 'operator', true)
    on conflict (id) do nothing
  `;
  // Migration-seeded weight sets (045 prospect-final, 069 citation-acvs) —
  // verbatim; keep in sync with those migrations.
  await sql`
    insert into scoring_weight_sets (name, version, weights, active, notes)
    values (
      'prospect-final', 1,
      '{"commercialAuthority": 0.30, "visibilityGap": 0.25,
        "adjustedFixability": 0.20, "competitorAdvantage": 0.10,
        "buyingSignals": 0.10, "contactability": 0.05}'::jsonb,
      true,
      'Seeded default (spec 039). Null components redistribute their weight.'
    )
  `;
  await sql`
    insert into scoring_weight_sets (name, version, weights, active, notes)
    values (
      'citation-acvs', 1,
      '{"citationFrequency": 0.15, "promptRelevance": 0.10,
        "commercialIntent": 0.15, "crossEngine": 0.10,
        "recommendationInfluence": 0.15, "competitorDensity": 0.10,
        "clientGap": 0.10, "feasibility": 0.05,
        "sourceQuality": 0.05, "persistence": 0.05}'::jsonb,
      true,
      'Seeded default (spec 060, acvs-v1). Null components redistribute.'
    )
  `;
  await seedTestActors(sql);
}
