/**
 * Integration tests for spec 080 — the Perplexity discovery adapter through
 * the real runProspectDiscovery flow with an injected fake transport:
 * candidates staged as ai_inferred leads, approval is the only path to a
 * prospect, failures recorded as failed runs, key absence fails closed.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import type { PerplexityResearchCaller } from "@/lib/ai/perplexity";
import { seedTestActors } from "../helpers/actors";
import { truncateAll } from "../helpers/db";
import { unwrap } from "../helpers/result";

const TEST_URL = process.env.TEST_DATABASE_URL;

const operator: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000401",
  email: "op@test.local",
  name: "Operator",
  role: "operator",
};
const admin: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "admin@test.local",
  name: "Admin",
  role: "admin",
};

const FOUND = {
  prospects: [
    {
      businessName: "Harbor & Vine Group",
      prospectType: "team",
      teamLeader: "Mia Harbor",
      brokerageAffiliation: "Compass",
      website: "https://harborvine.com",
      neighborhoods: ["Paulus Hook"],
      specialties: ["waterfront condos"],
      sourceUrl: "https://www.realtrends.com/rankings/hoboken",
    },
    {
      businessName: "Castle Point Realty",
      prospectType: "individual_agent",
      teamLeader: "Jon Castle",
      brokerageAffiliation: null,
      website: null,
      neighborhoods: null,
      specialties: null,
      sourceUrl: null,
    },
  ],
  confidence: 0.75,
};

function cannedCaller(output: unknown): PerplexityResearchCaller {
  return async () => ({
    text: JSON.stringify(output),
    citations: ["https://www.zillow.com/professionals/hoboken"],
    tokensIn: 400,
    tokensOut: 250,
  });
}

describe.skipIf(!TEST_URL)("perplexity discovery (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let exclusivity: typeof import("@/lib/exclusivity/service");
  let svc: typeof import("@/lib/prospects/service");
  let discovery: typeof import("@/lib/prospects/discovery");
  let registry: typeof import("@/lib/prospects/providers/registry");
  let provider: typeof import("@/lib/prospects/providers/perplexity");

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    // File-level clean slate: the shared schema is built once per
    // vitest run, so residue from earlier suites must be cleared here.
    await truncateAll(sql);
    exclusivity = await import("@/lib/exclusivity/service");
    svc = await import("@/lib/prospects/service");
    discovery = await import("@/lib/prospects/discovery");
    registry = await import("@/lib/prospects/providers/registry");
    provider = await import("@/lib/prospects/providers/perplexity");
    await seedTestActors(sql);
  });

  beforeEach(async () => {
    await sql.unsafe(
      `truncate audit_log, llm_calls, prospect_discovery_candidates,
       prospect_discovery_runs, prospect_activities, prospect_stage_history,
       prospects, market_launches,
       exclusivity_checks, exclusivity_scopes, exclusivity_agreements, markets
       cascade`
    );
  });

  afterEach(() => {
    registry.setProspectSourceForTests("perplexity", null);
  });

  afterAll(async () => {
    await sql.end();
  });

  async function seedLaunch(): Promise<string> {
    const market = unwrap(
      await exclusivity.createMarket(admin, { name: "Hoboken", kind: "city", aliases: [] })
    );
    const launch = unwrap(
      await svc.createLaunch(operator, {
        name: "Hoboken luxury residential",
        marketId: market.marketId,
        priceSegment: "luxury",
        serviceCategory: "residential brokerage",
      })
    );
    return launch.launchId;
  }

  it("stages found teams as ai_inferred review candidates; approval creates the prospect", async () => {
    const launchId = await seedLaunch();
    registry.setProspectSourceForTests(
      "perplexity",
      provider.createPerplexityProspectSource(cannedCaller(FOUND))
    );
    const run = unwrap(
      await discovery.runProspectDiscovery(operator, {
        launchId,
        provider: "perplexity",
        segment: "luxury",
      })
    );
    expect(run.candidateCount).toBe(2);

    const candidates = await discovery.listDiscoveryCandidates({ status: "pending" });
    expect(candidates).toHaveLength(2);
    const harbor = candidates.find((c) => c.businessName === "Harbor & Vine Group")!;
    expect(harbor.provenance).toBe("ai_inferred");
    expect(harbor.sourceUrl).toBe("https://www.realtrends.com/rankings/hoboken");
    // The item without its own citation falls back to the sweep's.
    const castle = candidates.find((c) => c.businessName === "Castle Point Realty")!;
    expect(castle.sourceUrl).toBe("https://www.zillow.com/professionals/hoboken");

    // Nothing became a prospect yet.
    const [before] = await sql`select count(*)::int as n from prospects`;
    expect(Number(before?.n)).toBe(0);

    unwrap(
      await discovery.reviewDiscoveryCandidate(operator, {
        candidateId: harbor.id,
        decision: "approve",
      })
    );
    const [prospect] = await sql`
      select business_name, team_leader from prospects where launch_id = ${launchId}
    `;
    expect(prospect?.businessName).toBe("Harbor & Vine Group");
    expect(prospect?.teamLeader).toBe("Mia Harbor");

    // The sweep ledgered.
    const [ledger] = await sql`
      select count(*)::int as n from llm_calls
      where agent_version = ${provider.DISCOVERY_VERSION} and success
    `;
    expect(Number(ledger?.n)).toBe(1);
  });

  it("records a failed run when the transport fails — never filled in", async () => {
    const launchId = await seedLaunch();
    registry.setProspectSourceForTests(
      "perplexity",
      provider.createPerplexityProspectSource(async () => {
        throw new Error("perplexity unreachable");
      })
    );
    const result = await discovery.runProspectDiscovery(operator, {
      launchId,
      provider: "perplexity",
    });
    expect(result.ok).toBe(false);
    const [run] = await sql`select status, error from prospect_discovery_runs`;
    expect(run?.status).toBe("failed");
    expect(String(run?.error)).toContain("perplexity unreachable");
  });

  it("fails closed without a key", async () => {
    const health = await provider.perplexityProspectSource.validateConfiguration();
    // In the test environment the key may or may not be set; assert the
    // CONTRACT both ways rather than the environment.
    if (process.env.PERPLEXITY_API_KEY) {
      expect(health.ok).toBe(true);
    } else {
      expect(health.ok).toBe(false);
      expect(health.detail).toContain("PERPLEXITY_API_KEY");
    }
  });
});
