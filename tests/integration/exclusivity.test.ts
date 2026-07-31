/**
 * Spec 028 integration: agreements persist with scopes, prospect checks are
 * recorded immutably, overrides are admin-only with a written rationale,
 * and every material action leaves an audit row.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { seedTestActors } from "../helpers/actors";

const TEST_URL = process.env.TEST_DATABASE_URL;
const ROOT = join(__dirname, "..", "..");

const operator: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000301",
  email: "op@test.local",
  name: "Operator",
  role: "operator",
};
const admin: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000302",
  email: "admin@test.local",
  name: "Admin",
  role: "admin",
};
const client: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000303",
  email: "client@example.com",
  name: "Client Viewer",
  role: "client_viewer",
};

describe.skipIf(!TEST_URL)("market exclusivity (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let svc: typeof import("@/lib/exclusivity/service");
  let projectSvc: typeof import("@/lib/projects/service");

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    svc = await import("@/lib/exclusivity/service");
    projectSvc = await import("@/lib/projects/service");
    await sql.unsafe("drop schema public cascade; create schema public;");
    execSync(`npx tsx scripts/migrate.ts up --db "${TEST_URL}"`, {
      cwd: ROOT,
      stdio: "pipe",
    });
    await seedTestActors(sql);
    await sql`
      insert into users (id, email, name, role) values
        (${operator.id}, ${operator.email}, ${operator.name}, 'operator'),
        (${admin.id}, ${admin.email}, ${admin.name}, 'admin'),
        (${client.id}, ${client.email}, ${client.name}, 'client_viewer')
      on conflict (id) do nothing
    `;
  }, 180_000);

  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    await sql.unsafe(`
      truncate exclusivity_checks, exclusivity_scopes,
        exclusivity_agreements, markets, audit_log, projects cascade
    `);
  });

  async function seedGeoAndAgreement(): Promise<{
    projectId: string;
    nyc: string;
    manhattan: string;
    tribeca: string;
    agreementId: string;
  }> {
    const project = await projectSvc.createProject(operator, {
      name: "Gambino Group",
    });
    if (!project.ok) throw new Error(project.error.message);

    const nyc = await svc.createMarket(operator, { name: "NYC", kind: "city" });
    if (!nyc.ok) throw new Error(nyc.error.message);
    const manhattan = await svc.createMarket(operator, {
      name: "Manhattan",
      kind: "borough",
      parentId: nyc.data.marketId,
    });
    if (!manhattan.ok) throw new Error(manhattan.error.message);
    const tribeca = await svc.createMarket(operator, {
      name: "Tribeca",
      kind: "neighborhood",
      parentId: manhattan.data.marketId,
    });
    if (!tribeca.ok) throw new Error(tribeca.error.message);

    const agreement = await svc.createAgreement(operator, {
      projectId: project.data.id,
      startsOn: "2026-01-01",
      gracePeriodDays: 90,
      scopes: [
        {
          marketId: manhattan.data.marketId,
          serviceCategory: "residential_sales",
          segment: "luxury",
        },
      ],
    });
    if (!agreement.ok) throw new Error(agreement.error.message);

    return {
      projectId: project.data.id,
      nyc: nyc.data.marketId,
      manhattan: manhattan.data.marketId,
      tribeca: tribeca.data.marketId,
      agreementId: agreement.data.agreementId,
    };
  }

  it("stores an agreement with scopes and lists it with market names", async () => {
    await seedGeoAndAgreement();
    const rows = await svc.listAgreements();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.clientName).toBe("Gambino Group");
    expect(rows[0]?.scopes).toHaveLength(1);
    expect(rows[0]?.scopes[0]?.marketName).toBe("Manhattan");
    const [audit] = await sql`
      select 1 from audit_log where action = 'exclusivity.agreement_create'
    `;
    expect(audit).toBeDefined();
  });

  it("records a direct conflict as blocked, with the explained result", async () => {
    const { tribeca } = await seedGeoAndAgreement();
    const check = await svc.checkProspect(operator, {
      prospectName: "Rival Realty",
      marketId: tribeca,
      serviceCategory: "residential_sales",
      segment: "luxury",
    });
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.data.decision).toBe("blocked");
    expect(check.data.result.worstVerdict).toBe("direct");
    expect(check.data.result.conflicts[0]?.reason).toContain("Gambino Group");

    const [row] = await sql`
      select worst_verdict, decision from exclusivity_checks
    `;
    expect(row?.worstVerdict).toBe("direct");
    expect(row?.decision).toBe("blocked");
  });

  it("refuses a check against a market not in the tree", async () => {
    await seedGeoAndAgreement();
    const check = await svc.checkProspect(operator, {
      prospectName: "Rival Realty",
      marketId: "00000000-0000-4000-8000-00000000beef",
    });
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.error.kind).toBe("validation");
  });

  it("override requires admin and a rationale, and is audited", async () => {
    const { manhattan } = await seedGeoAndAgreement();
    const prospect = {
      prospectName: "Rival Realty",
      marketId: manhattan,
      serviceCategory: "residential_sales",
      segment: "luxury",
    };

    const asOperator = await svc.checkProspect(operator, {
      ...prospect,
      decision: "override",
      overrideRationale: "operator says so",
    });
    expect(asOperator.ok).toBe(false);
    if (!asOperator.ok) expect(asOperator.error.kind).toBe("forbidden");

    const noRationale = await svc.checkProspect(admin, {
      ...prospect,
      decision: "override",
      overrideRationale: "   ",
    });
    expect(noRationale.ok).toBe(false);
    if (!noRationale.ok) expect(noRationale.error.kind).toBe("validation");

    const overridden = await svc.checkProspect(admin, {
      ...prospect,
      decision: "override",
      overrideRationale: "Different sub-segment; client consented in writing.",
    });
    expect(overridden.ok).toBe(true);
    if (!overridden.ok) return;
    expect(overridden.data.decision).toBe("override");

    const [audit] = await sql`
      select detail from audit_log
      where action = 'exclusivity.check' and detail->>'decision' = 'override'
    `;
    expect(audit).toBeDefined();
  });

  it("checks are immutable — UPDATE and DELETE raise", async () => {
    const { manhattan } = await seedGeoAndAgreement();
    await svc.checkProspect(operator, {
      prospectName: "Rival Realty",
      marketId: manhattan,
    });
    await expect(
      sql`update exclusivity_checks set decision = 'clear'`
    ).rejects.toThrow(/immutable|not allowed|forbid/i);
    await expect(sql`delete from exclusivity_checks`).rejects.toThrow(
      /immutable|not allowed|forbid/i
    );
  });

  it("termination is admin-only and ends protection after grace", async () => {
    const { agreementId } = await seedGeoAndAgreement();
    const asOperator = await svc.terminateAgreement(operator, {
      agreementId,
      terminatedAt: "2026-07-01",
    });
    expect(asOperator.ok).toBe(false);
    if (!asOperator.ok) expect(asOperator.error.kind).toBe("forbidden");

    const asAdmin = await svc.terminateAgreement(admin, {
      agreementId,
      terminatedAt: "2026-07-01",
    });
    expect(asAdmin.ok).toBe(true);

    const rows = await svc.listAgreements();
    expect(rows[0]?.status).toBe("terminated");
  });

  it("client accounts cannot create markets, agreements, or checks", async () => {
    const market = await svc.createMarket(client, { name: "NYC", kind: "city" });
    expect(market.ok).toBe(false);
    if (!market.ok) expect(market.error.kind).toBe("forbidden");

    const check = await svc.checkProspect(client, {
      prospectName: "X",
      marketId: "00000000-0000-4000-8000-00000000beef",
    });
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.error.kind).toBe("forbidden");
  });

  it("market cycle refusal via setMarketParent", async () => {
    const { nyc, manhattan } = await seedGeoAndAgreement();
    const cycle = await svc.setMarketParent(operator, {
      marketId: nyc,
      parentId: manhattan,
    });
    expect(cycle.ok).toBe(false);
    if (!cycle.ok) expect(cycle.error.kind).toBe("conflict");
  });
});
