/**
 * Spec 135 over the real database: quotes recorded from sent copy with the
 * policy version, founder-recorded outcomes, engagement signing under the
 * active policy (defaults, override discipline, stored default), fixture
 * exclusion and the dashboard's pricing counts.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { seedTestActors } from "../helpers/actors";
import { unwrap } from "../helpers/result";
import { seedProspect, type PipelineModules } from "../helpers/prospect-fixtures";

const TEST_URL = process.env.TEST_DATABASE_URL;
const ROOT = join(__dirname, "..", "..");
const operator: CurrentUser = { id: "00000000-0000-4000-8000-000000000401", email: "op@test.local", name: "Operator", role: "operator" };
const admin: CurrentUser = { id: "00000000-0000-4000-8000-000000000001", email: "admin@test.local", name: "Admin", role: "admin" };
const SCOPE = "AI recommendation diagnosis over the frozen baseline question set; implementation of high-confidence changes; remeasurement.";

describe.skipIf(!TEST_URL)("pricing policy (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let projectSvc: typeof import("@/lib/projects/service");
  let setSvc: typeof import("@/lib/prompts/set-service");
  let promptSvc: typeof import("@/lib/prompts/prompt-service");
  let runSvc: typeof import("@/lib/runs/service");
  let execute: typeof import("@/lib/runs/execute");
  let jobs: typeof import("@/db/jobs");
  let companySvc: typeof import("@/lib/companies/service");
  let claims: typeof import("@/lib/claims/service");
  let parsing: typeof import("@/lib/parsing/service");
  let scoring: typeof import("@/lib/scoring/compute");
  let exclusivity: typeof import("@/lib/exclusivity/service");
  let svc: typeof import("@/lib/prospects/service");
  let quotes: typeof import("@/lib/pricing/quotes");
  let eng: typeof import("@/lib/engagements/service");
  let mock: typeof import("@/lib/ai/mock");

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    projectSvc = await import("@/lib/projects/service");
    setSvc = await import("@/lib/prompts/set-service");
    promptSvc = await import("@/lib/prompts/prompt-service");
    runSvc = await import("@/lib/runs/service");
    execute = await import("@/lib/runs/execute");
    jobs = await import("@/db/jobs");
    companySvc = await import("@/lib/companies/service");
    claims = await import("@/lib/claims/service");
    parsing = await import("@/lib/parsing/service");
    scoring = await import("@/lib/scoring/compute");
    exclusivity = await import("@/lib/exclusivity/service");
    svc = await import("@/lib/prospects/service");
    quotes = await import("@/lib/pricing/quotes");
    eng = await import("@/lib/engagements/service");
    mock = await import("@/lib/ai/mock");
    await sql.unsafe("drop schema public cascade; create schema public;");
    execSync(`npx tsx scripts/migrate.ts up --db "${TEST_URL}"`, { cwd: ROOT, stdio: "pipe" });
    await seedTestActors(sql);
  });

  beforeEach(async () => {
    await sql.unsafe(
      `truncate audit_log, jobs, pricing_quotes, billing_events, engagement_measurements, client_engagements,
       prospect_activities, prospect_stage_history, outreach_drafts, prospect_audit_views, prospect_audits,
       prospect_findings, prospect_benchmarks, prospect_authority_signals, prospect_contacts,
       prospects, market_launches, exclusivity_checks, exclusivity_scopes, exclusivity_agreements, markets,
       claims, competitors, scores, sources, response_parses, mentions, response_citations, brand_candidates,
       companies, responses, runs, prompt_set_versions, prompts, prompt_sets, projects cascade`
    );
    mock.resetMockProvider();
  });

  afterAll(async () => {
    await sql.end();
  });

  const modules = (): PipelineModules => ({ sql, projectSvc, setSvc, promptSvc, runSvc, execute, jobs, companySvc, claims, parsing, scoring, exclusivity, svc });

  async function quoteFor(prospectId: string, body: string): Promise<string | null> {
    return sql.begin((tx) => quotes.recordQuoteFromSend(tx, { prospectId, draftId: null, sendId: null, channel: "email", body, sentAt: new Date(), userId: operator.id }));
  }

  it("6/8: a sent body stating the current offer records a quote under the active policy; other bodies record nothing", async () => {
    const f = await seedProspect(modules(), operator, admin, { projectKind: "prospect" });
    expect(await quoteFor(f.prospectId, "Ryan,\n\nHere it is: https://x.test/report/a/b")).toBeNull();
    const id = await quoteFor(f.prospectId, "The 90-day engagement is $7,500. We bill it as $2,500 per month over the 90 days.");
    expect(id).not.toBeNull();
    const [q] = await sql`select pricing_policy_version, total_fee_usd, term_days, status, billing_structure from pricing_quotes where id = ${id}`;
    expect(q!.pricingPolicyVersion).toBe("first_client_90d_v1");
    expect(Number(q!.totalFeeUsd)).toBe(7500);
    expect(Number(q!.termDays)).toBe(90);
    expect(q!.status).toBe("presented");
    expect((q!.billingStructure as { installments: number }).installments).toBe(3);
    const [act] = await sql`select count(*)::int as n from prospect_activities where prospect_id = ${f.prospectId} and kind = 'pricing_quoted'`;
    expect(Number(act!.n)).toBe(1);
  });

  it("4: a historical v0 body records the retired policy at its price — history, not the menu", async () => {
    const f = await seedProspect(modules(), operator, admin, { projectKind: "prospect" });
    const id = await quoteFor(f.prospectId, "Here it is: $7,500/month for 3 months, $22,500 total initial engagement.");
    const [q] = await sql`select pricing_policy_version, total_fee_usd from pricing_quotes where id = ${id}`;
    expect(q!.pricingPolicyVersion).toBe("founder_monthly_7500_v0");
    expect(Number(q!.totalFeeUsd)).toBe(22500);
  });

  it("14: outcomes and the dashboard's pricing counts; fixtures excluded", async () => {
    const f = await seedProspect(modules(), operator, admin, { projectKind: "prospect" });
    const id = (await quoteFor(f.prospectId, "The 90-day engagement is $7,500."))!;
    unwrap(await quotes.recordQuoteOutcome(operator, { quoteId: id, status: "declined", objections: ["PRICE_TOO_HIGH", "PREFERS_DIY"], preferredSolution: "DIY", lostReason: "price higher than willing to spend; will learn it internally" }));
    const [q] = await sql`select status, outcome, objections, total_fee_usd, pricing_policy_version from pricing_quotes where id = ${id}`;
    expect(q!.status).toBe("declined");
    expect(q!.outcome).toBe("lost");
    expect(q!.objections).toEqual(["PRICE_TOO_HIGH", "PREFERS_DIY"]);
    // The outcome never touches the quoted price or policy.
    expect(Number(q!.totalFeeUsd)).toBe(7500);
    expect(q!.pricingPolicyVersion).toBe("first_client_90d_v1");
    // A fixture-launch quote must not count.
    await sql`update market_launches set name = 'QA131 fixture launch' where id = (select launch_id from prospects where id = ${f.prospectId})`;
    let learning = await quotes.pricingLearning();
    expect(learning.offersPresented).toBe(0);
    await sql`update market_launches set name = 'Manhattan luxury residential'`;
    learning = await quotes.pricingLearning();
    expect(learning.activeOffer).toMatchObject({ version: "first_client_90d_v1", price: "$7,500 / 90 days", billing: "$2,500 × 3" });
    expect(learning.realConversations).toBe(1);
    expect(learning.offersPresented).toBe(1);
    expect(learning.accepted).toBe(0);
    expect(learning.declinedOnPrice).toBe(1);
    expect(learning.diyPreference).toBe(1);
    expect(learning.clientsWon).toBe(0);
    expect(learning.cacUsd).toBeNull();
    expect(learning.arpuUsd).toBeNull();
    expect(learning.paymentsReceivedUsd).toBe(0);
    expect(learning.conversations[0]).toMatchObject({ prospect: "Rivera Team", priceQuoted: "$7,500", termDays: 90, response: "declined", outcome: "lost" });
    expect(learning.milestones.find((m) => m.key === "EARLY_PRICING_REVIEW")).toMatchObject({ current: 1, threshold: 3, reached: false });
  });

  it("2/10/11: signing defaults to the active policy; a different total needs a founder reason and keeps the default", async () => {
    const f = await seedProspect(modules(), operator, admin, { projectKind: "prospect" });
    await sql`update prospects set stage = 'verbal_yes' where id = ${f.prospectId}`;
    const refused = await eng.signClient(operator, { prospectId: f.prospectId, startsOn: "2026-10-01", monthlyFeeUsd: 2000, totalValueUsd: 6000, scopeSummary: SCOPE });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toMatch(/override reason is required/);
    const signed = unwrap(await eng.signClient(operator, { prospectId: f.prospectId, startsOn: "2026-10-01", monthlyFeeUsd: 2500, totalValueUsd: 7500, scopeSummary: SCOPE }));
    const [e] = await sql`select pricing_policy_version, default_total_value_usd, price_override_reason, total_value_usd, ends_on::text from client_engagements where id = ${signed.engagementId}`;
    expect(e!.pricingPolicyVersion).toBe("first_client_90d_v1");
    expect(Number(e!.defaultTotalValueUsd)).toBe(7500);
    expect(e!.priceOverrideReason).toBeNull();
    expect(Number(e!.totalValueUsd)).toBe(7500);
    expect(e!.endsOn).toBe("2026-12-30");
  });

  it("11: an explicit override records reason, actual and default side by side", async () => {
    const f = await seedProspect(modules(), operator, admin, { projectKind: "prospect" });
    await sql`update prospects set stage = 'verbal_yes' where id = ${f.prospectId}`;
    const signed = unwrap(await eng.signClient(operator, { prospectId: f.prospectId, startsOn: "2026-10-01", monthlyFeeUsd: 5000, totalValueUsd: 15000, priceOverrideReason: "two defined markets in scope", scopeSummary: SCOPE }));
    const [e] = await sql`select pricing_policy_version, default_total_value_usd, price_override_reason, total_value_usd from client_engagements where id = ${signed.engagementId}`;
    expect(e).toMatchObject({ pricingPolicyVersion: "first_client_90d_v1", priceOverrideReason: "two defined markets in scope" });
    expect(Number(e!.defaultTotalValueUsd)).toBe(7500);
    expect(Number(e!.totalValueUsd)).toBe(15000);
  });
});
