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
  brokerages: ["Test Realty"],
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

  it("market identity: same display name in two states ⇒ two projects bound to two markets; NC never adopts DE", async () => {
    const NC = "bbbbbbbb-0000-4000-8000-000000000031";
    const DE = "bbbbbbbb-0000-4000-8000-000000000032";
    const LAUNCH_NC = "bbbbbbbb-0000-4000-8000-000000000041";
    const LAUNCH_DE = "bbbbbbbb-0000-4000-8000-000000000042";
    // Same city name under two state parents (markets_name_per_parent_unique).
    const NC_STATE = "bbbbbbbb-0000-4000-8000-000000000051";
    const DE_STATE = "bbbbbbbb-0000-4000-8000-000000000052";
    await sql`insert into markets (id, name, kind, state_code) values (${NC_STATE}, 'North Carolina', 'state', 'NC'), (${DE_STATE}, 'Delaware', 'state', 'DE')`;
    await sql`insert into markets (id, name, kind, state_code, parent_id) values (${NC}, 'Wilmington', 'city', 'NC', ${NC_STATE}), (${DE}, 'Wilmington', 'city', 'DE', ${DE_STATE})`;
    await sql`insert into market_launches (id, name, market_id, status)
      values (${LAUNCH_NC}, 'Wilmington NC — luxury', ${NC}, 'researching'), (${LAUNCH_DE}, 'Wilmington DE — luxury', ${DE}, 'researching')`;
    await sql`insert into market_pack_drafts (city_name, payload, citations, model, agent_version, status, created_by)
      values ('Wilmington', ${sql.json({ ...PACK, key: "wilmington", cityName: "Wilmington", hierarchy: { name: "Wilmington", kind: "city", children: [] } } as never)}, '[]'::jsonb, 'test', 'test-v1', 'installed', ${operator.id})`;

    const nc = unwrap(await bootstrap.bootstrapMarketBenchmark(operator, { launchId: LAUNCH_NC }));
    const de = unwrap(await bootstrap.bootstrapMarketBenchmark(operator, { launchId: LAUNCH_DE }));
    expect(nc.alreadyBootstrapped).toBe(false);
    expect(de.alreadyBootstrapped).toBe(false);
    expect(nc.projectId).not.toBe(de.projectId);
    const rows = await sql`select id, market_id, name from projects where id in (${nc.projectId}, ${de.projectId}) order by name`;
    expect(rows.map((r) => [r.marketId, r.name])).toEqual([[DE, "Market benchmark: Wilmington, DE"], [NC, "Market benchmark: Wilmington, NC"]]);

    // Idempotent on market_id, not on the label.
    const ncAgain = unwrap(await bootstrap.bootstrapMarketBenchmark(operator, { launchId: LAUNCH_NC }));
    expect(ncAgain.alreadyBootstrapped).toBe(true);
    expect(ncAgain.projectId).toBe(nc.projectId);

    // Two projects cannot bind the same market.
    await expect(sql`update projects set market_id = ${NC} where id = ${de.projectId}`).rejects.toThrow(/projects_market_benchmark_uidx/);
  });

  it("market identity: a legacy name-keyed project not bound to a market is REVIEW_REQUIRED, never adopted", async () => {
    const SC = "bbbbbbbb-0000-4000-8000-000000000033";
    const LAUNCH_SC = "bbbbbbbb-0000-4000-8000-000000000043";
    await sql`insert into markets (id, name, kind, state_code) values (${SC}, 'Springfield', 'city', 'IL')`;
    await sql`insert into market_launches (id, name, market_id, status) values (${LAUNCH_SC}, 'Springfield — luxury', ${SC}, 'researching')`;
    await sql`insert into market_pack_drafts (city_name, payload, citations, model, agent_version, status, created_by)
      values ('Springfield', ${sql.json({ ...PACK, key: "springfield", cityName: "Springfield" } as never)}, '[]'::jsonb, 'test', 'test-v1', 'installed', ${operator.id})`;
    await sql`insert into projects (name, kind) values ('Market benchmark: Springfield', 'prospect')`;
    const res = await bootstrap.bootstrapMarketBenchmark(operator, { launchId: LAUNCH_SC });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toMatch(/PROJECT_MARKET_REVIEW_REQUIRED/);
    const [count] = await sql`select count(*)::int as n from projects where name like 'Market benchmark: Springfield%'`;
    expect(count?.n).toBe(1);
  });

  it("market identity: an installed pack scoped to another STATE is refused (PACK_MARKET_MISMATCH), never bootstrapped", async () => {
    // Dover, DE launch; the only installed "Dover" pack is hierarchy-scoped to
    // North Carolina (the state market inserted by the Wilmington test above).
    const DOVER = "bbbbbbbb-0000-4000-8000-000000000034";
    const LAUNCH_DOVER = "bbbbbbbb-0000-4000-8000-000000000044";
    await sql`insert into markets (id, name, kind, state_code, parent_id) values (${DOVER}, 'Dover', 'city', 'DE', 'bbbbbbbb-0000-4000-8000-000000000052')`;
    await sql`insert into market_launches (id, name, market_id, status) values (${LAUNCH_DOVER}, 'Dover — luxury', ${DOVER}, 'researching')`;
    await sql`insert into market_pack_drafts (city_name, payload, citations, model, agent_version, status, created_by)
      values ('Dover', ${sql.json({ ...PACK, key: "dover-nc", cityName: "Dover", hierarchy: { name: "NC", kind: "state", children: [] } } as never)}, '[]'::jsonb, 'test', 'test-v1', 'installed', ${operator.id})`;
    const res = await bootstrap.bootstrapMarketBenchmark(operator, { launchId: LAUNCH_DOVER });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toMatch(/PACK_MARKET_MISMATCH/);
    const [count] = await sql`select count(*)::int as n from projects where market_id = ${DOVER}`;
    expect(count?.n).toBe(0);
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
