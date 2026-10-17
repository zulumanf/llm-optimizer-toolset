/**
 * Release 151 task 6: cross-client isolation for every spec-151 surface.
 * Client A (granted project A) must read A only, write nothing, and never
 * see B, staff-only aggregates, or another brokerage.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { truncateAll } from "../helpers/db";
import type { CurrentUser } from "@/lib/auth";

const TEST_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_URL)("spec 151 tenant isolation (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  const clientA: CurrentUser = { id: "00000000-0000-4000-8000-00000000c0a1", email: "a@client.test", name: "Client A", role: "client_viewer" } as CurrentUser;
  const clientB: CurrentUser = { id: "00000000-0000-4000-8000-00000000c0b1", email: "b@client.test", name: "Client B", role: "client_validator" } as CurrentUser;
  let projectA: string;
  let projectB: string;
  let companyB: string;
  let orgA: string;
  let orgB: string;

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
  });
  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    await truncateAll(sql);
    for (const u of [clientA, clientB]) {
      await sql`insert into users (id, email, name, role) values (${u.id}, ${u.email}, ${u.name}, ${u.role}) on conflict do nothing`;
    }
    const [a] = await sql`insert into projects (name) values ('Project A') returning id`;
    const [b] = await sql`insert into projects (name) values ('Project B') returning id`;
    projectA = a!.id as string;
    projectB = b!.id as string;
    const [cb] = await sql`insert into companies (name) values ('B Co') returning id`;
    companyB = cb!.id as string;
    await sql`update projects set subject_company_id = ${companyB} where id = ${projectB}`;
    await sql`insert into user_project_access (user_id, project_id) values (${clientA.id}, ${projectA}), (${clientB.id}, ${projectB})`;
    await sql`insert into client_outcomes (project_id, period_start, period_end, provenance, qualified_leads)
      values (${projectB}, '2026-09-01', '2026-09-30', 'self_reported', 9)`;
    const [oa] = await sql`insert into organizations (name) values ('Org A') returning id`;
    const [ob] = await sql`insert into organizations (name) values ('Org B') returning id`;
    orgA = oa!.id as string;
    orgB = ob!.id as string;
    await sql`insert into organization_grants (organization_id, user_id) values (${orgA}, ${clientA.id})`;
  });

  it("reads: a client sees its own project and nothing of another client's", async () => {
    const plan = await import("@/lib/optimization/plan");
    const econ = await import("@/lib/economics/service");
    const experiments = await import("@/lib/experiments/service");
    const onboarding = await import("@/lib/onboarding/service");
    const structured = await import("@/lib/optimization/structured-data");
    const orgs = await import("@/lib/organizations/service");

    // Own project: allowed (and empty).
    await expect(plan.listOpportunities(clientA, projectA)).resolves.toEqual([]);
    await expect(econ.listClientOutcomes(clientA, projectA)).resolves.toEqual([]);

    // Other client's project: not found, never forbidden (existence hidden).
    const readsOfB = [
      () => plan.listOpportunities(clientA, projectB),
      () => econ.listClientOutcomes(clientA, projectB),
      () => experiments.listPlans(clientA, projectB),
      () => onboarding.onboardingChecklist(clientA, projectB),
      () => structured.structuredDataSuggestion(clientA, projectB, "agent_business"),
    ];
    for (const read of readsOfB) await expect(read()).rejects.toThrow(/not found/i);

    // Brokerage rosters: own grant only; other org and staff lists hidden.
    await expect(orgs.organizationRoster(clientA, orgA)).resolves.toMatchObject({ organization: "Org A" });
    await expect(orgs.organizationRoster(clientA, orgB)).rejects.toThrow(/not found/i);
    await expect(orgs.organizationRoster(clientB, orgA)).rejects.toThrow(/not found/i);
    expect((await orgs.visibleOrganizations(clientA)).map((o) => o.name)).toEqual(["Org A"]);
    expect(await orgs.visibleOrganizations(clientB)).toEqual([]);
    // A revoked grant closes access immediately.
    await sql`update organization_grants set revoked_at = now() where organization_id = ${orgA}`;
    await expect(orgs.organizationRoster(clientA, orgA)).rejects.toThrow(/not found/i);
  });

  it("staff-only cross-client aggregates refuse every client role", async () => {
    const econ = await import("@/lib/economics/service");
    const ex = await import("@/lib/operations/exceptions");
    const experiments = await import("@/lib/experiments/service");
    const predictions = await import("@/lib/experiments/predictions");
    const orgs = await import("@/lib/organizations/service");
    for (const client of [clientA, clientB]) {
      await expect(econ.unitEconomics(client, { from: "2026-01-01", to: "2026-12-31" })).rejects.toThrow(/read-only/);
      await expect(ex.exceptionQueue(client)).rejects.toThrow(/read-only/);
      await expect(experiments.learningSummary(client)).rejects.toThrow(/read-only/);
      await expect(predictions.evaluatePredictions(client)).rejects.toThrow(/read-only/);
      await expect(orgs.organizationFormData(client)).rejects.toThrow(/read-only/);
    }
  });

  it("writes: every spec-151 mutation refuses client roles, even on their own project", async () => {
    const plan = await import("@/lib/optimization/plan");
    const econ = await import("@/lib/economics/service");
    const experiments = await import("@/lib/experiments/service");
    const measurement = await import("@/lib/measurement/service");
    const onboarding = await import("@/lib/onboarding/service");
    const gold = await import("@/lib/evaluation/gold");
    const orgs = await import("@/lib/organizations/service");
    const predictions = await import("@/lib/experiments/predictions");
    const fakeId = "00000000-0000-4000-8000-0000000000aa";
    const writes = [
      () => plan.buildOptimizationPlan(clientA, { projectId: projectA }),
      () => plan.transitionOpportunity(clientA, { opportunityId: fakeId, to: "approved" }),
      () => econ.recordClientOutcome(clientA, { projectId: projectA, periodStart: "2026-09-01", periodEnd: "2026-09-30", provenance: "self_reported", qualifiedLeads: 1 }),
      () => econ.recordLabor(clientA, { projectId: projectA, activity: "support", minutes: 5, occurredOn: "2026-09-01" }),
      () => measurement.freezeCompetitorCohort(clientA, { projectId: projectA, reason: "client attempt" }),
      () => measurement.pinMeasurementInstrument(clientA, { projectId: projectA, providers: [{ provider: "openai", model: "m", repetitions: 1 }], reason: "client attempt" }),
      () => onboarding.prepareMeasurement(clientA, { projectId: projectA, promptSetVersionId: fakeId, budgetUsdPerWave: 1 }),
      () => onboarding.runInitialAnalysis(clientA, { projectId: projectA }),
      () => experiments.approvePlan(clientA, { planId: fakeId }),
      () => experiments.linkPlanIntervention(clientA, { planId: fakeId, interventionId: fakeId }),
      () => gold.createGoldSample(clientA, { name: "client attempt", size: 20, seed: 1 }),
      () => gold.recordAnnotation(clientA, { itemId: fakeId, sameEntity: true, mentioned: true, recommended: true }),
      () => orgs.createOrganization(clientA, { name: "Client org" }),
      () => orgs.addOrganizationEntity(clientA, { organizationId: orgA, companyId: companyB, level: "team" }),
      () => orgs.grantOrganizationAccess(clientA, { organizationId: orgA, userId: clientA.id }),
      () => predictions.recordPrediction(clientA, {
        planId: fakeId, predictor: "x", predictorVersion: "v", basis: "human", predictedChange: 0,
        predictedLow: 0, predictedHigh: 0, probabilityImprovement: 0.5, rationale: "client attempt",
      }),
    ];
    for (const write of writes) {
      const r = await write();
      expect(r.ok).toBe(false);
      if (!r.ok) expect(["forbidden", "not_found", "validation"]).toContain(r.error.kind);
    }
    // Nothing was written anywhere.
    const [{ n }] = (await sql`
      select (select count(*) from opportunities) + (select count(*) from labor_entries)
        + (select count(*) from competitor_cohorts) + (select count(*) from measurement_instruments)
        + (select count(*) from gold_samples) + (select count(*) from organizations where name = 'Client org')
        + (select count(*) from organization_entities) + (select count(*) from client_outcomes where project_id = ${projectA}) as n
    `) as unknown as [{ n: string }];
    expect(Number(n)).toBe(0);
  });
});
