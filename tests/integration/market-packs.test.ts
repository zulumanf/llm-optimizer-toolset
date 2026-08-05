/**
 * Integration tests for spec 040 — market-pack installation into the real
 * markets tree (idempotency, alias merge, containment, cycle guard) and
 * prompt generation into a real prompt set with lineage.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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

describe.skipIf(!TEST_URL)("market packs (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let install: typeof import("@/lib/markets/install");
  let generate: typeof import("@/lib/markets/generate");
  let packs: typeof import("@/lib/markets/packs");
  let detect: typeof import("@/lib/exclusivity/detect");
  let projectSvc: typeof import("@/lib/projects/service");
  let setSvc: typeof import("@/lib/prompts/set-service");

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    install = await import("@/lib/markets/install");
    generate = await import("@/lib/markets/generate");
    packs = await import("@/lib/markets/packs");
    detect = await import("@/lib/exclusivity/detect");
    projectSvc = await import("@/lib/projects/service");
    setSvc = await import("@/lib/prompts/set-service");
    await sql.unsafe("drop schema public cascade; create schema public;");
    execSync(`npx tsx scripts/migrate.ts up --db "${TEST_URL}"`, {
      cwd: ROOT,
      stdio: "pipe",
    });
    await seedTestActors(sql);
  });

  beforeEach(async () => {
    await sql.unsafe(
      `truncate audit_log, market_pack_installs, markets,
       prompts, prompt_set_versions, prompt_sets, projects cascade`
    );
  });

  afterAll(async () => {
    await sql.end();
  });


  async function marketByName(name: string): Promise<{ id: string } | undefined> {
    const [row] = await sql`select id from markets where name = ${name}`;
    return row as { id: string } | undefined;
  }

  it("installs the hierarchy with correct containment, idempotently, sharing ancestors across packs", async () => {
    const first = unwrap(await install.installMarketPack(operator, { packKey: "nyc" }));
    expect(first.created).toBeGreaterThan(15);
    expect(first.matched).toBe(0);
    expect(first.cityMarketId).not.toBeNull();

    // Containment via the exclusivity machinery — one tree, one logic.
    const markets = await sql`select id, name, parent_id from markets`;
    const nodes = markets.map((m) => ({
      id: m.id as string,
      name: m.name as string,
      parentId: (m.parentId as string | null) ?? null,
    }));
    const id = async (name: string) => (await marketByName(name))!.id;
    expect(detect.geoRelation(await id("Tribeca"), await id("Manhattan"), nodes)).toBe("inside");
    expect(detect.geoRelation(await id("Tribeca"), first.cityMarketId!, nodes)).toBe("inside");
    expect(detect.geoRelation(first.cityMarketId!, await id("Tribeca"), nodes)).toBe("contains");
    expect(detect.geoRelation(await id("New York City"), await id("New York"), nodes)).toBe(
      "inside"
    );
    expect(detect.geoRelation(await id("Tribeca"), await id("Williamsburg"), nodes)).toBe(
      "sibling"
    );

    // Re-install: nothing new, everything matched.
    const again = unwrap(await install.installMarketPack(operator, { packKey: "nyc" }));
    expect(again.created).toBe(0);
    expect(again.matched).toBe(first.created);
    const [count] = await sql`select count(*)::int as n from markets`;
    expect(count?.n).toBe(first.created);

    // A second pack shares "United States" instead of duplicating it.
    const jc = unwrap(await install.installMarketPack(operator, { packKey: "jersey-city" }));
    expect(jc.matched).toBeGreaterThanOrEqual(1);
    const usa = await sql`select id from markets where name = 'United States'`;
    expect(usa.length).toBe(1);

    // Install provenance recorded with the definition snapshot.
    const [installRow] = await sql`
      select pack_key, version, definition from market_pack_installs where pack_key = 'nyc'
    `;
    expect(installRow?.version).toBe(1);
    expect((installRow?.definition as { cityName: string }).cityName).toBe("New York City");
  });

  it("matches existing markets by alias and merges alias lists", async () => {
    await sql`insert into markets (name, kind, aliases) values ('USA', 'country', '{}')`;
    const result = unwrap(await install.installMarketPack(operator, { packKey: "boston" }));
    expect(result.matched).toBeGreaterThanOrEqual(1);
    const rows = await sql`
      select name, aliases from markets where kind = 'country'
    `;
    expect(rows.length).toBe(1); // matched by the USA alias, not duplicated
    expect(rows[0]?.aliases).toContain("US");
  });

  it("quick-start: one call installs the pack and opens the launch; a repeat says 'already started'", async () => {
    const quickstart = await import("@/lib/prospects/quickstart");
    const first = unwrap(
      await quickstart.quickStartLaunch(operator, { packKey: "jersey-city" })
    );
    expect(first.cityName).toBe("Jersey City");
    const [launch] = await sql`
      select l.name, m.name as market_name from market_launches l
      join markets m on m.id = l.market_id where l.id = ${first.launchId}
    `;
    expect(launch).toMatchObject({
      name: "Jersey City — luxury residential",
      marketName: "Jersey City",
    });
    const again = await quickstart.quickStartLaunch(operator, { packKey: "jersey-city" });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.message).toContain("already started");
    const unknown = await quickstart.quickStartLaunch(operator, { packKey: "atlantis" });
    expect(unknown.ok).toBe(false);
  });

  it("the cycle guard refuses a parent cycle", async () => {
    unwrap(await install.installMarketPack(operator, { packKey: "chicago" }));
    const [city] = await sql`select id from markets where name = 'Chicago'`;
    const [state] = await sql`select id from markets where name = 'Illinois'`;
    await expect(
      sql`update markets set parent_id = ${city?.id} where id = ${state?.id}`
    ).rejects.toThrow(/cycle/);
  });

  it("generates prompts with lineage into a set, idempotently, honoring the cap report", async () => {
    const project = unwrap(await projectSvc.createProject(operator, { name: "Prospect M" }));
    const set = unwrap(
      await setSvc.createPromptSet(operator, { projectId: project.id, name: "Miami set" })
    );

    const report = unwrap(
      await generate.generateMarketPrompts(operator, { setId: set.id, packKey: "miami" })
    );
    expect(report.created).toBeGreaterThan(20);
    expect(report.skippedExisting).toBe(0);
    expect(report.excluded.map((e) => e.name)).toContain("Downtown Miami");

    const prompts = await sql`
      select text, category, tier, source, audience, price_tier, template_ref
      from prompts where prompt_set_id = ${set.id} and archived_at is null
    `;
    expect(prompts.length).toBe(report.created);
    expect(prompts.every((p) => p.source === "expansion")).toBe(true);
    const brickell = prompts.find(
      (p) => p.text === "Who should I use to sell a condo in Brickell?"
    );
    expect(brickell).toMatchObject({
      tier: 1,
      audience: "seller",
      templateRef: "miami@v1:sell-property-neighborhood",
    });
    const tiered = prompts.find((p) => p.priceTier === "ultra-luxury");
    expect(tiered?.templateRef).toBe("miami@v1:price-tier-specialist");
    // No excluded neighborhood leaked into any text.
    expect(prompts.some((p) => (p.text as string).includes("Downtown Miami"))).toBe(false);

    // Second run: everything already present, nothing duplicated.
    const rerun = unwrap(
      await generate.generateMarketPrompts(operator, { setId: set.id, packKey: "miami" })
    );
    expect(rerun.created).toBe(0);
    expect(rerun.skippedExisting).toBe(report.created);
    const [count] = await sql`
      select count(*)::int as n from prompts
      where prompt_set_id = ${set.id} and archived_at is null
    `;
    expect(count?.n).toBe(report.created);

    // Options narrow the expansion.
    const set2 = unwrap(
      await setSvc.createPromptSet(operator, { projectId: project.id, name: "Brickell only" })
    );
    const narrow = unwrap(
      await generate.generateMarketPrompts(operator, {
        setId: set2.id,
        packKey: "miami",
        templateKeys: ["neighborhood-specialist"],
        neighborhoods: ["Brickell"],
      })
    );
    expect(narrow.created).toBe(1);
    const [only] = await sql`
      select text from prompts where prompt_set_id = ${set2.id} and archived_at is null
    `;
    expect(only?.text).toBe("Which real estate agents specialize in Brickell?");
  });
});
