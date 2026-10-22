/**
 * Release 151 migration safety: rollbacks refuse to destroy data unless
 * explicitly allowed, the scoring switch cannot be dropped while past its
 * baseline, and everything re-applies cleanly afterwards.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { truncateAll } from "../helpers/db";
import { migrate } from "../../scripts/migrate";

const TEST_URL = process.env.TEST_DATABASE_URL;
const quiet = () => undefined;

describe.skipIf(!TEST_URL)("spec 151 migration guards (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    await truncateAll(sql);
  });
  afterAll(async () => {
    // Whatever happened, leave the schema fully migrated for later files.
    await migrate("up", TEST_URL as string, quiet);
    await truncateAll(sql);
    await sql.end();
  });

  async function latest(): Promise<string> {
    const [row] = await sql`select name from schema_migrations order by applied_at desc, name desc limit 1`;
    return row?.name as string;
  }

  it("132 refuses to drop the scoring switch while readers are on v1.2; data-holding downs refuse; the flag allows", async () => {
    try {
      // Later migrations (empty tables) revert cleanly down to 132.
      while ((await latest()) > "132_scoring_cutover.sql") await migrate("down", TEST_URL as string, quiet);
      expect(await latest()).toBe("132_scoring_cutover.sql");

      await sql`update scoring_state set read_version = 'v1.2'`;
      await expect(migrate("down", TEST_URL as string, quiet)).rejects.toThrow(/past the v1.1 baseline/);
      expect(await latest()).toBe("132_scoring_cutover.sql");
      await sql`update scoring_state set read_version = 'v1.1'`;

      await migrate("down", TEST_URL as string, quiet); // 132 at baseline, empty history
      expect(await latest()).toBe("131_organizations.sql");
      await sql`insert into organizations (name) values ('Keep me')`;
      await expect(migrate("down", TEST_URL as string, quiet)).rejects.toThrow(/organizations holds 1 row/);
      expect(await latest()).toBe("131_organizations.sql");
      await migrate("down", TEST_URL as string, quiet, { allowDestructiveDown: true });
      expect(await latest()).toBe("130_outcomes_and_labor.sql");
    } finally {
      await sql`update scoring_state set read_version = 'v1.1'`.catch(() => undefined);
      await migrate("up", TEST_URL as string, quiet);
    }
    expect(await latest()).toBe("135_outreach_unsubscribe_tokens.sql");
    const [state] = await sql`select read_version, write_legacy from scoring_state`;
    expect(state).toMatchObject({ readVersion: "v1.1", writeLegacy: true });
  });

  it("two concurrent runners serialize instead of racing", async () => {
    await Promise.all([migrate("up", TEST_URL as string, quiet), migrate("up", TEST_URL as string, quiet)]);
    const [{ n }] = (await sql`select count(*)::int as n from schema_migrations where name = '134_scores_staging_and_backup_runs.sql'`) as unknown as [{ n: number }];
    expect(n).toBe(1);
  });
});
