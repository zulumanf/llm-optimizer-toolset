/**
 * Integration tests for spec 041 — the discovery flow end to end: mock
 * adapter → enveloped candidates → human review → prospect with per-fact
 * provenance and auto-linked company; plus the suggestion read and the
 * cross-launch duplicate surface.
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
const admin: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "admin@test.local",
  name: "Admin",
  role: "admin",
};

describe.skipIf(!TEST_URL)("prospect discovery (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let discovery: typeof import("@/lib/prospects/discovery");
  let svc: typeof import("@/lib/prospects/service");
  let companySvc: typeof import("@/lib/companies/service");
  let exclusivity: typeof import("@/lib/exclusivity/service");

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    discovery = await import("@/lib/prospects/discovery");
    svc = await import("@/lib/prospects/service");
    companySvc = await import("@/lib/companies/service");
    exclusivity = await import("@/lib/exclusivity/service");
    await sql.unsafe("drop schema public cascade; create schema public;");
    execSync(`npx tsx scripts/migrate.ts up --db "${TEST_URL}"`, {
      cwd: ROOT,
      stdio: "pipe",
    });
    await seedTestActors(sql);
  });

  beforeEach(async () => {
    await sql.unsafe(
      `truncate audit_log,
       prospect_discovery_candidates, prospect_discovery_runs,
       prospect_activities, prospect_stage_history, prospect_contacts,
       prospect_authority_signals, prospects, market_launches,
       exclusivity_checks, exclusivity_scopes, exclusivity_agreements, markets,
       companies cascade`
    );
  });

  afterAll(async () => {
    await sql.end();
  });


  async function seedLaunch(marketName = "Manhattan"): Promise<string> {
    const market = unwrap(
      await exclusivity.createMarket(admin, { name: marketName, kind: "borough", aliases: [] })
    );
    const launch = unwrap(
      await svc.createLaunch(operator, {
        name: `${marketName} luxury residential`,
        marketId: market.marketId,
      })
    );
    return launch.launchId;
  }

  it("runs discovery, stores enveloped candidates, and approval creates a provenance-labeled prospect", async () => {
    const launchId = await seedLaunch();
    // A tracked company whose name matches a fixture team → auto-link on approve.
    const harborlight = unwrap(
      await companySvc.upsertCompany(operator, { name: "Harborlight Realty" })
    );
    // A tracked brokerage matching a fixture's affiliation → must NOT link.
    unwrap(await companySvc.upsertCompany(operator, { name: "Compass" }));

    const run = unwrap(
      await discovery.runProspectDiscovery(operator, { launchId, provider: "mock" })
    );
    expect(run.candidateCount).toBe(3);
    const [runRow] = await sql`
      select status, candidate_count from prospect_discovery_runs where id = ${run.runId}
    `;
    expect(runRow).toMatchObject({ status: "completed", candidateCount: 3 });

    const pending = await discovery.listDiscoveryCandidates({ launchId, status: "pending" });
    expect(pending.length).toBe(3);
    const harbor = pending.find((c) => c.businessName === "Harborlight Realty Team")!;
    expect(harbor.provider).toBe("mock");
    expect(harbor.provenance).toBe("publicly_sourced");
    expect(harbor.sourceUrl).toContain("Manhattan");
    expect(harbor.payload.brokerageAffiliation).toBe("Compass");

    const review = unwrap(
      await discovery.reviewDiscoveryCandidate(operator, {
        candidateId: harbor.id,
        decision: "approve",
      })
    );
    expect(review.outcome).toBe("approved");
    expect(review.prospectId).not.toBeNull();

    const [prospect] = await sql`
      select business_name, source, company_id, field_provenance, website
      from prospects where id = ${review.prospectId}
    `;
    expect(prospect?.source).toBe("research");
    // Resolver: "Harborlight Realty Team" ≈ "Harborlight Realty" → auto-link;
    // "Compass" is a brokerage collision and never the identity.
    expect(prospect?.companyId).toBe(harborlight.id);
    const provenance = prospect?.fieldProvenance as Record<string, string>;
    expect(provenance.website).toBe("publicly_sourced");
    expect(provenance.brokerageAffiliation).toBe("publicly_sourced");

    // The stored resolution explains the decision, brokerage collision included.
    const [reviewed] = await sql`
      select resolution, status from prospect_discovery_candidates where id = ${harbor.id}
    `;
    expect(reviewed?.status).toBe("approved");
    const resolution = reviewed?.resolution as {
      verdict: string;
      brokerageCollisions: { name: string }[];
    };
    expect(resolution.verdict).toBe("match");
    expect(resolution.brokerageCollisions.map((b) => b.name)).toContain("Compass");

    // A candidate can only be reviewed once.
    const again = await discovery.reviewDiscoveryCandidate(operator, {
      candidateId: harbor.id,
      decision: "approve",
    });
    expect(again.ok).toBe(false);
  });

  it("dismissal and duplicate outcomes are recorded, never errors", async () => {
    const launchId = await seedLaunch();
    unwrap(await discovery.runProspectDiscovery(operator, { launchId, provider: "mock" }));
    const pending = await discovery.listDiscoveryCandidates({ launchId, status: "pending" });
    const bluepeak = pending.find((c) => c.businessName === "Bluepeak Property Advisors")!;

    // Dismiss one.
    const dismissed = unwrap(
      await discovery.reviewDiscoveryCandidate(operator, {
        candidateId: bluepeak.id,
        decision: "dismiss",
      })
    );
    expect(dismissed.outcome).toBe("dismissed");

    // Pre-create the same business in the launch → approval records duplicate.
    const meridian = pending.find((c) => c.businessName === "Meridian Rowhouse Group")!;
    unwrap(
      await svc.createProspect(operator, {
        launchId,
        businessName: "Meridian Rowhouse Group",
        prospectType: "team",
      })
    );
    const dup = unwrap(
      await discovery.reviewDiscoveryCandidate(operator, {
        candidateId: meridian.id,
        decision: "approve",
      })
    );
    expect(dup.outcome).toBe("duplicate");
    expect(dup.prospectId).toBeNull();
    const [row] = await sql`
      select status, created_prospect_id from prospect_discovery_candidates
      where id = ${meridian.id}
    `;
    expect(row).toMatchObject({ status: "duplicate", createdProspectId: null });
  });

  it("suggests a company for an unlinked prospect; confirming links it audited", async () => {
    const launchId = await seedLaunch();
    const rivera = unwrap(await companySvc.upsertCompany(operator, { name: "Rivera Team" }));
    unwrap(await companySvc.upsertCompany(operator, { name: "Compass" }));
    const prospect = unwrap(
      await svc.createProspect(operator, {
        launchId,
        businessName: "The Rivera Group",
        prospectType: "team",
        brokerageAffiliation: "Compass",
      })
    );

    const suggestion = await discovery.suggestCompanyForProspect(prospect.prospectId);
    expect(suggestion?.verdict).toBe("match");
    expect(suggestion?.companyId).toBe(rivera.id);
    expect(suggestion?.brokerageCollisions.map((b) => b.name)).toContain("Compass");

    unwrap(
      await discovery.confirmCompanyLink(operator, {
        prospectId: prospect.prospectId,
        companyId: rivera.id,
      })
    );
    const [linked] = await sql`
      select company_id from prospects where id = ${prospect.prospectId}
    `;
    expect(linked?.companyId).toBe(rivera.id);
    // Linked prospects no longer get suggestions.
    expect(await discovery.suggestCompanyForProspect(prospect.prospectId)).toBeNull();
  });

  it("surfaces cross-launch duplicates by name, domain, and company", async () => {
    const launchA = await seedLaunch("Manhattan");
    const launchB = await seedLaunch("Brooklyn");
    const rivera = unwrap(await companySvc.upsertCompany(operator, { name: "Rivera Team" }));

    unwrap(
      await svc.createProspect(operator, {
        launchId: launchA,
        businessName: "Rivera Team",
        website: "https://riverateam.com",
        companyId: rivera.id,
      })
    );
    unwrap(
      await svc.createProspect(operator, {
        launchId: launchB,
        businessName: "The Rivera Group",
        website: "https://www.riverateam.com",
        companyId: rivera.id,
      })
    );
    unwrap(
      await svc.createProspect(operator, {
        launchId: launchB,
        businessName: "Unrelated Team",
      })
    );

    const pairs = await discovery.listProspectDuplicates();
    const reasons = pairs.map((p) => p.reason).sort();
    expect(reasons).toContain("same_domain");
    expect(reasons).toContain("same_company");
    // "Rivera Team" vs "The Rivera Group" normalize to different strings
    // ("rivera" vs "rivera"): The/Group/Team all strip → same_name too.
    expect(reasons).toContain("same_name");
    expect(pairs.every((p) => p.a.id !== p.b.id)).toBe(true);
    expect(pairs.some((p) => p.a.businessName === "Unrelated Team")).toBe(false);
  });
});
