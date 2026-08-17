/**
 * Integration tests for spec 082 — market-pack drafts with a fake research
 * transport: assembly into a valid pack, install-through-review creating
 * the tree + launch, rejection installing nothing, failure rows, and the
 * registry path's behavior preserved through the shared installer.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import type { PerplexityResearchCaller } from "@/lib/ai/perplexity";
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

const RESEARCH = {
  neighborhoods: ["Uptown", "Downtown", "The Heights", "Waterfront"],
  brokerages: ["Compass", "Corcoran"],
  publications: ["Hoboken Girl"],
  propertyTypes: ["condo", "brownstone"],
  confidence: 0.8,
};

function cannedCaller(output: unknown): PerplexityResearchCaller {
  return async () => ({
    text: JSON.stringify(output),
    citations: ["https://www.niche.com/places-to-live/hoboken"],
    tokensIn: 300,
    tokensOut: 200,
  });
}

describe.skipIf(!TEST_URL)("market pack drafts (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let research: typeof import("@/lib/markets/research");
  let install: typeof import("@/lib/markets/install");

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    research = await import("@/lib/markets/research");
    install = await import("@/lib/markets/install");
    await sql.unsafe("drop schema public cascade; create schema public;");
    execSync(`npx tsx scripts/migrate.ts up --db "${TEST_URL}"`, {
      cwd: ROOT,
      stdio: "pipe",
    });
    await seedTestActors(sql);
  });

  beforeEach(async () => {
    await sql.unsafe(
      `truncate audit_log, llm_calls, market_pack_drafts, market_pack_installs,
       prospect_activities, prospects, market_launches,
       exclusivity_checks, exclusivity_scopes, exclusivity_agreements, markets
       cascade`
    );
  });

  afterAll(async () => {
    await sql.end();
  });

  it("drafts, installs through review, and opens the launch", async () => {
    const drafted = unwrap(
      await research.draftMarketPack(
        operator,
        { cityName: "Hoboken", state: "New Jersey" },
        cannedCaller(RESEARCH)
      )
    );
    expect(drafted.error).toBeNull();
    expect(drafted.pack?.key).toBe("draft:hoboken");
    expect(drafted.pack?.templates.length).toBeGreaterThan(0);

    // Nothing installed yet.
    const [preMarkets] = await sql`select count(*)::int as n from markets`;
    expect(Number(preMarkets?.n)).toBe(0);

    const installed = unwrap(
      await research.installMarketPackDraft(operator, { draftId: drafted.draftId })
    );
    expect(installed.cityName).toBe("Hoboken");

    const marketRows = await sql`select name, kind from markets order by name`;
    const names = marketRows.map((m) => `${m.kind}:${m.name}`);
    expect(names).toContain("city:Hoboken");
    expect(names).toContain("neighborhood:Uptown");
    expect(names).toContain("region:New Jersey");
    const [launch] = await sql`select name from market_launches`;
    expect(launch?.name).toContain("Hoboken");
    const [installRow] = await sql`select pack_key from market_pack_installs`;
    expect(installRow?.packKey).toBe("draft:hoboken");

    // Deciding twice refuses.
    const again = await research.installMarketPackDraft(operator, {
      draftId: drafted.draftId,
    });
    expect(again.ok).toBe(false);

    // The sweep ledgered.
    const [ledger] = await sql`
      select count(*)::int as n from llm_calls
      where agent_version = ${research.PACK_DRAFT_VERSION} and success
    `;
    expect(Number(ledger?.n)).toBe(1);
  });

  it("rejection installs nothing; a failed call stores a failed draft", async () => {
    const drafted = unwrap(
      await research.draftMarketPack(
        operator,
        { cityName: "Hoboken", state: "New Jersey" },
        cannedCaller(RESEARCH)
      )
    );
    unwrap(await research.rejectMarketPackDraft(operator, { draftId: drafted.draftId }));
    const [markets] = await sql`select count(*)::int as n from markets`;
    expect(Number(markets?.n)).toBe(0);
    const blocked = await research.installMarketPackDraft(operator, {
      draftId: drafted.draftId,
    });
    expect(blocked.ok).toBe(false);

    const failed = unwrap(
      await research.draftMarketPack(
        operator,
        { cityName: "Weehawken", state: "New Jersey" },
        async () => ({ text: "no json here", citations: [], tokensIn: 10, tokensOut: 5 })
      )
    );
    expect(failed.error).not.toBeNull();
    const [row] = await sql`
      select status from market_pack_drafts where city_name = 'Weehawken'
    `;
    expect(row?.status).toBe("failed");
  });

  it("registry packs still install through the shared path", async () => {
    const result = unwrap(await install.installMarketPack(operator, { packKey: "jersey-city" }));
    expect(result.cityMarketId).not.toBeNull();
    const [city] = await sql`select 1 from markets where name = 'Jersey City' and kind = 'city'`;
    expect(city).toBeDefined();
  });
});
