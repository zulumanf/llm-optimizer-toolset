/**
 * Integration tests for spec 079 — Perplexity enrichment with an injected
 * fake caller (docs/09: tests never touch the network): staging with
 * citations, the zero-cost skip paths, approval materializing real
 * contacts/signals with honest provenance, rejection, failure rows, and
 * the sweep's freshness window.
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
const admin: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "admin@test.local",
  name: "Admin",
  role: "admin",
};

const FULL_FIND = {
  email: "ana@riverateam.com",
  emailContactName: "Ana Rivera",
  emailSourceUrl: "https://riverateam.com/contact",
  production: {
    volumeUsd: 23_300_000,
    sides: 24,
    rank: 3,
    rankScope: "Jersey City individuals by volume",
    year: 2026,
    sourceUrl: "https://www.realtrends.com/rankings",
  },
  confidence: 0.8,
  notes: "",
};

function cannedCaller(output: unknown): PerplexityResearchCaller {
  return async () => ({
    text: JSON.stringify(output),
    citations: ["https://www.realtrends.com/rankings", "https://riverateam.com/contact"],
    tokensIn: 300,
    tokensOut: 150,
  });
}

describe.skipIf(!TEST_URL)("perplexity enrichment (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let exclusivity: typeof import("@/lib/exclusivity/service");
  let svc: typeof import("@/lib/prospects/service");
  let enrichment: typeof import("@/lib/prospects/enrichment");

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    exclusivity = await import("@/lib/exclusivity/service");
    svc = await import("@/lib/prospects/service");
    enrichment = await import("@/lib/prospects/enrichment");
    await sql.unsafe("drop schema public cascade; create schema public;");
    execSync(`npx tsx scripts/migrate.ts up --db "${TEST_URL}"`, {
      cwd: ROOT,
      stdio: "pipe",
    });
    await seedTestActors(sql);
  });

  beforeEach(async () => {
    await sql.unsafe(
      `truncate audit_log, llm_calls, enrichment_proposals, prospect_buying_signals,
       prospect_activities, prospect_stage_history, prospect_contacts,
       prospect_authority_signals, prospects, market_launches,
       exclusivity_checks, exclusivity_scopes, exclusivity_agreements, markets
       cascade`
    );
  });

  afterAll(async () => {
    await sql.end();
  });

  async function seedProspect(): Promise<{ prospectId: string; launchId: string }> {
    const market = unwrap(
      await exclusivity.createMarket(admin, { name: "Jersey City", kind: "city", aliases: [] })
    );
    const launch = unwrap(
      await svc.createLaunch(operator, {
        name: "Jersey City luxury residential",
        marketId: market.marketId,
        priceSegment: "luxury",
        serviceCategory: "residential brokerage",
      })
    );
    const prospect = unwrap(
      await svc.createProspect(operator, {
        launchId: launch.launchId,
        businessName: "Rivera Team",
        prospectType: "team",
        teamLeader: "Ana Rivera",
        brokerageAffiliation: "Compass",
      })
    );
    return { prospectId: prospect.prospectId, launchId: launch.launchId };
  }

  it("stages cited proposals for everything missing, then approval materializes them honestly", async () => {
    const { prospectId } = await seedProspect();
    const result = unwrap(
      await enrichment.enrichProspect(operator, { prospectId }, cannedCaller(FULL_FIND))
    );
    expect(result.outcome).toBe("enriched");
    expect(result.proposals).toBe(4); // email + volume + sides + rank

    const proposals = await enrichment.listEnrichmentProposals(prospectId);
    expect(proposals).toHaveLength(4);
    expect(proposals.every((p) => p.citations.length === 2)).toBe(true);

    for (const proposal of proposals) {
      unwrap(await enrichment.approveEnrichmentProposal(operator, { proposalId: proposal.id }));
    }
    const [contact] = await sql`
      select email, provenance from prospect_contacts where prospect_id = ${prospectId}
    `;
    expect(contact?.email).toBe("ana@riverateam.com");
    expect(contact?.provenance).toBe("ai_inferred");
    const signals = await sql`
      select kind, value_number, provenance, source_url from prospect_authority_signals
      where prospect_id = ${prospectId} order by kind
    `;
    expect(signals.map((s) => s.kind)).toEqual([
      "ranking",
      "transaction_count",
      "transaction_volume",
    ]);
    // Cited → publicly_sourced, NEVER verified from research alone.
    expect(signals.every((s) => s.provenance === "publicly_sourced")).toBe(true);
    expect(Number(signals.find((s) => s.kind === "transaction_volume")?.valueNumber)).toBe(
      23_300_000
    );
    // The ledger saw the call.
    const [ledger] = await sql`
      select count(*)::int as n from llm_calls
      where agent_version = ${enrichment.ENRICHMENT_VERSION} and success
    `;
    expect(Number(ledger?.n)).toBe(1);
  });

  it("asks only for what is missing and skips a fully-known prospect at zero cost", async () => {
    const { prospectId } = await seedProspect();
    unwrap(
      await svc.addContact(operator, {
        prospectId,
        name: "Ana Rivera",
        email: "known@riverateam.com",
      })
    );
    let seenQuestion = "";
    const spyCaller: PerplexityResearchCaller = async (args) => {
      seenQuestion = args.user;
      return cannedCaller({ ...FULL_FIND, email: null })(args);
    };
    unwrap(await enrichment.enrichProspect(operator, { prospectId }, spyCaller));
    expect(seenQuestion).not.toContain('"email"');
    expect(seenQuestion).toContain("closed sales volume");

    // Approve the production signals → only TIMING research remains
    // (spec 081: buying-signal freshness is part of "known").
    for (const proposal of await enrichment.listEnrichmentProposals(prospectId)) {
      unwrap(await enrichment.approveEnrichmentProposal(operator, { proposalId: proposal.id }));
    }
    let signalQuestion = "";
    const signalsCaller: PerplexityResearchCaller = async (args) => {
      signalQuestion = args.user;
      return {
        text: JSON.stringify({
          email: null,
          production: null,
          recentDevelopments: [
            {
              kind: "brokerage_move",
              headline: "Rivera Team moved from Compass to Serhant",
              date: "2026-08-01",
              sourceUrl: "https://therealdeal.com/rivera-moves",
            },
            {
              kind: "won_big_award",
              headline: "Unknown-kind development maps to other",
              date: null,
              sourceUrl: null,
            },
          ],
          confidence: 0.7,
          notes: "",
        }),
        citations: ["https://therealdeal.com/rivera-moves"],
        tokensIn: 200,
        tokensOut: 100,
      };
    };
    const timing = unwrap(
      await enrichment.enrichProspect(operator, { prospectId, force: true }, signalsCaller)
    );
    expect(timing.outcome).toBe("enriched");
    expect(timing.proposals).toBe(2);
    expect(signalQuestion).toContain("recentDevelopments");
    expect(signalQuestion).not.toContain("closed sales volume");

    const staged = await enrichment.listEnrichmentProposals(prospectId);
    const signals = staged.filter((p) => p.kind === "buying_signal");
    expect(signals).toHaveLength(2);
    expect(signals.map((p) => p.payload.kind).sort()).toEqual(["brokerage_move", "other"]);

    // Approve one → real buying signal with honest provenance; the score
    // component wakes up.
    const move = signals.find((p) => p.payload.kind === "brokerage_move")!;
    unwrap(await enrichment.approveEnrichmentProposal(operator, { proposalId: move.id }));
    const [row] = await sql`
      select kind, provenance, observed_on::text as observed_on
      from prospect_buying_signals where prospect_id = ${prospectId}
    `;
    expect(row?.kind).toBe("brokerage_move");
    expect(row?.provenance).toBe("publicly_sourced");
    expect(row?.observedOn).toBe("2026-08-01");

    // Now signals are fresh AND facts are known: truly zero-cost.
    let called = false;
    const neverCaller: PerplexityResearchCaller = async (args) => {
      called = true;
      return cannedCaller(FULL_FIND)(args);
    };
    const skip = unwrap(
      await enrichment.enrichProspect(operator, { prospectId, force: true }, neverCaller)
    );
    expect(skip.outcome).toBe("skipped_complete");
    expect(called).toBe(false);
  });

  it("honors the freshness window in the sweep; rejection decides without materializing", async () => {
    const { prospectId, launchId } = await seedProspect();
    unwrap(await enrichment.enrichProspect(operator, { prospectId }, cannedCaller(FULL_FIND)));

    // Sweep immediately after: fresh → zero calls.
    let calls = 0;
    const countingCaller: PerplexityResearchCaller = async (args) => {
      calls += 1;
      return cannedCaller(FULL_FIND)(args);
    };
    const sweep = unwrap(
      await enrichment.sweepEnrichment(operator, { launchId }, countingCaller)
    );
    expect(sweep.outcomes[0]?.outcome).toBe("skipped_fresh");
    expect(calls).toBe(0);

    const [before] = await sql`
      select count(*)::int as n from prospect_contacts where prospect_id = ${prospectId}
    `;
    const proposals = await enrichment.listEnrichmentProposals(prospectId);
    for (const proposal of proposals) {
      unwrap(await enrichment.rejectEnrichmentProposal(operator, { proposalId: proposal.id }));
    }
    const [after] = await sql`
      select count(*)::int as n from prospect_contacts where prospect_id = ${prospectId}
    `;
    expect(after?.n).toBe(before?.n);
    expect(await enrichment.listEnrichmentProposals(prospectId)).toHaveLength(0);
  });

  it("stores a failure row when the model never returns valid JSON — no fabricated absence", async () => {
    const { prospectId } = await seedProspect();
    const badCaller: PerplexityResearchCaller = async () => ({
      text: "I could not find anything, sorry!",
      citations: [],
      tokensIn: 50,
      tokensOut: 20,
    });
    const result = unwrap(
      await enrichment.enrichProspect(operator, { prospectId }, badCaller)
    );
    expect(result.outcome).toBe("failed");
    const rows = await enrichment.listEnrichmentProposals(prospectId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("failed");
    const [ledger] = await sql`
      select success from llm_calls where agent_version = ${enrichment.ENRICHMENT_VERSION}
    `;
    expect(ledger?.success).toBe(false);
  });
});
