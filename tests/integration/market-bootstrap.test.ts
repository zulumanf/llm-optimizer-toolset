/**
 * Spec 096 follow-up — bootstrapMarketBenchmark: the rung between an
 * installed market pack and a benchmark run. Creates project + prompt set
 * from the installed pack, freezes it, returns run-ready ids; idempotent.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { seedTestActors } from "../helpers/actors";
import { unwrap } from "../helpers/result";

const TEST_URL = process.env.TEST_DATABASE_URL;
const ROOT = join(__dirname, "..", "..");

const operator: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000401",
  email: "op@test.local",
  name: "Operator",
  role: "operator",
};

const PACK = {
  key: "testville-de",
  version: 1,
  cityName: "Testville",
  hierarchy: { name: "Testville", kind: "city", children: [] },
  zipCodes: [],
  propertyTypes: ["condo"],
  primaryPropertyTypes: ["condo"],
  priceTiers: [],
  buyerSegments: [],
  sellerSegments: [],
  terminology: {},
  brokerages: [],
  publications: [],
  excludedPlaceNames: [],
  templates: [
    {
      key: "best-agent",
      text: "Who is the best real estate agent in {city}?",
      category: "recommendation",
      tier: 1,
      audience: "buyer",
      scope: "city",
    },
    {
      key: "sell-with",
      text: "Which team should I sell my {city} home with?",
      category: "recommendation",
      tier: 1,
      audience: "seller",
      scope: "city",
    },
  ],
};

describe.skipIf(!TEST_URL)("market benchmark bootstrap (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let bootstrap: typeof import("@/lib/markets/bootstrap");
  const LAUNCH = "cccccccc-0000-4000-8000-000000000021";

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    bootstrap = await import("@/lib/markets/bootstrap");
    await sql.unsafe("drop schema public cascade; create schema public;");
    execSync(`npx tsx scripts/migrate.ts up --db "${TEST_URL}"`, {
      cwd: ROOT,
      stdio: "pipe",
    });
    await seedTestActors(sql);
    await sql`insert into markets (id, name, kind) values ('bbbbbbbb-0000-4000-8000-000000000021', 'Testville', 'city')`;
    await sql`insert into market_launches (id, name, market_id, status)
      values (${LAUNCH}, 'Testville — luxury residential', 'bbbbbbbb-0000-4000-8000-000000000021', 'researching')`;
    await sql`insert into market_pack_drafts (city_name, payload, citations, model, agent_version, status, created_by)
      values ('Testville', ${sql.json(PACK as never)}, '[]'::jsonb, 'test', 'test-v1', 'installed', ${operator.id})`;
  });

  afterAll(async () => {
    await sql.end();
  });

  it("bootstraps project + frozen prompt set from the installed pack", async () => {
    const result = unwrap(
      await bootstrap.bootstrapMarketBenchmark(operator, { launchId: LAUNCH })
    );
    expect(result.alreadyBootstrapped).toBe(false);
    expect(result.promptCount).toBe(2);
    expect(result.projectId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.promptSetVersionId).toMatch(/^[0-9a-f-]{36}$/);
    const [version] = await sql`
      select frozen_at from prompt_set_versions where id = ${result.promptSetVersionId}
    `;
    expect(version?.frozenAt).not.toBeNull();
    const prompts = await sql`
      select text from prompts where prompt_set_id = ${result.promptSetId} and archived_at is null
    `;
    expect(prompts.map((p) => p.text as string).join(" ")).toContain("Testville");
  });

  it("a second bootstrap is idempotent — same plumbing, no duplicate project", async () => {
    const again = unwrap(
      await bootstrap.bootstrapMarketBenchmark(operator, { launchId: LAUNCH })
    );
    expect(again.alreadyBootstrapped).toBe(true);
    const [count] = await sql`
      select count(*)::int as n from projects where name like 'Market benchmark: Testville%'
    `;
    expect(count?.n).toBe(1);
  });

  it("refuses when no installed pack exists for the market", async () => {
    await sql`insert into markets (id, name, kind) values ('bbbbbbbb-0000-4000-8000-000000000022', 'Packless', 'city')`;
    await sql`insert into market_launches (id, name, market_id, status)
      values ('cccccccc-0000-4000-8000-000000000022', 'Packless launch', 'bbbbbbbb-0000-4000-8000-000000000022', 'researching')`;
    const result = await bootstrap.bootstrapMarketBenchmark(operator, {
      launchId: "cccccccc-0000-4000-8000-000000000022",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/No installed market pack/);
  });
});
