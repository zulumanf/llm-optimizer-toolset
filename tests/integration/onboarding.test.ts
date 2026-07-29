/**
 * Integration tests for spec 012 — client onboarding: one call produces a
 * fully configured, reviewable client, with no cross-client leakage.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";

const TEST_URL = process.env.TEST_DATABASE_URL;
const ROOT = join(__dirname, "..", "..");

const user: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000801",
  email: "op@test.local",
  name: "Operator",
  role: "operator",
};

describe.skipIf(!TEST_URL)("client onboarding (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let onboarding: typeof import("@/lib/verticals/onboarding");

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    onboarding = await import("@/lib/verticals/onboarding");
    await sql.unsafe("drop schema public cascade; create schema public;");
    execSync(`npx tsx scripts/migrate.ts up --db "${TEST_URL}"`, {
      cwd: ROOT,
      stdio: "pipe",
    });
  });

  beforeEach(async () => {
    await sql.unsafe(
      `truncate audit_log, jobs, accuracy_findings, evidence_exports,
       client_validation_observations, client_validation_runs, audit_samples,
       evidence_artifacts, content_versions, content_assets, gap_findings,
       claims, tasks, evidence, intervention_runs, interventions, reports,
       brand_candidates, competitors, scores, sources, response_parses,
       mentions, companies, responses, runs, prompt_set_versions, prompts,
       prompt_sets, projects, vertical_packs cascade`
    );
  });

  afterAll(async () => {
    await sql.end();
  });

  const realtorInput = {
    clientName: "Gambino Group — NYC",
    packKey: "real-estate-agent",
    company: {
      name: "Gambino Group",
      aliases: ["Gambino Team"],
      domain: "gambinogroup.com",
    },
    variables: {
      market: ["Jersey City", "Hoboken"],
      clientType: ["first-time buyers", "sellers"],
      neighborhood: ["Downtown Jersey City"],
      propertyType: ["condo"],
    },
    facts: [
      {
        key: "category_positioning",
        text: "Gambino Group is a real estate team serving Jersey City and Hoboken.",
        evidenceUrl: "https://gambinogroup.com/about",
      },
      {
        key: "brokerage",
        text: "Gambino Group is affiliated with Compass as of 2026-07.",
        evidenceUrl: "https://compass.com/agents/gambino",
      },
    ],
    competitors: [
      { name: "Compass NJ", domain: "compass.com", tier: "primary" as const },
      { name: "Douglas Elliman", domain: "elliman.com", tier: "secondary" as const },
    ],
  };

  it("onboards a full client in one call, ready for human review", async () => {
    const result = await onboarding.onboardClient(user, realtorInput);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.promptsCreated).toBeGreaterThan(8);
    expect(result.data.claimsApproved).toBe(2);
    expect(result.data.competitorsTracked).toBe(2);

    // Pack pinned as an immutable snapshot on the project
    const [project] = await sql`
      select p.name, p.vertical_pack_id, vp.key, vp.version
      from projects p join vertical_packs vp on vp.id = p.vertical_pack_id
      where p.id = ${result.data.projectId}
    `;
    expect(project?.key).toBe("real-estate-agent");
    expect(project?.version).toBe(1);

    // Subject wired, claims approved and agent-usable
    const [subject] = await sql`
      select c.name from projects p join companies c on c.id = p.subject_company_id
      where p.id = ${result.data.projectId}
    `;
    expect(subject?.name).toBe("Gambino Group");
    const claims = await sql`
      select key, status from claims where project_id = ${result.data.projectId}
    `;
    expect(claims.every((c) => c.status === "approved")).toBe(true);

    // Prompts generated with real substitutions, holdouts preserved, NOT frozen
    const prompts = await sql`
      select text, category, is_holdout from prompts
      where prompt_set_id = ${result.data.promptSetId}
    `;
    expect(prompts.length).toBe(result.data.promptsCreated);
    expect(prompts.every((p) => !(p.text as string).includes("{"))).toBe(true);
    expect(
      prompts.some((p) => (p.text as string).includes("Jersey City"))
    ).toBe(true);
    expect(prompts.some((p) => p.isHoldout)).toBe(true);
    const versions = await sql`
      select count(*)::int as n from prompt_set_versions
      where prompt_set_id = ${result.data.promptSetId}
    `;
    expect(versions[0]?.n).toBe(0); // freezing stays a human decision

    // Onboarding is audited as a single event
    const audits = await sql`
      select detail from audit_log where action = 'client.onboard'
    `;
    expect(audits).toHaveLength(1);
    expect((audits[0]?.detail as { packKey: string }).packKey).toBe(
      "real-estate-agent"
    );
  });

  it("rejects missing required inputs with a usable message", async () => {
    const result = await onboarding.onboardClient(user, {
      ...realtorInput,
      variables: { neighborhood: ["Downtown"] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Primary market(s)");
      expect(result.error.message).toContain("Client situation(s)");
    }
    // Nothing partially created
    const [count] = await sql`select count(*)::int as n from projects`;
    expect(count?.n).toBe(0);
  });

  it("rejects an unknown pack", async () => {
    const result = await onboarding.onboardClient(user, {
      ...realtorInput,
      packKey: "not-a-vertical",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("Unknown vertical pack");
  });

  it("two clients in different verticals stay isolated and pin their own packs", async () => {
    const realtor = await onboarding.onboardClient(user, realtorInput);
    const surgeon = await onboarding.onboardClient(user, {
      clientName: "Dr Rivera Aesthetics",
      packKey: "medical-aesthetics",
      company: { name: "Rivera Aesthetics", aliases: [], domain: "rivera.md" },
      variables: { market: ["Miami"], procedure: ["rhinoplasty"] },
      facts: [],
      competitors: [],
    });
    expect(realtor.ok && surgeon.ok).toBe(true);
    if (!realtor.ok || !surgeon.ok) return;

    const packs = await sql`
      select vp.key from projects p join vertical_packs vp on vp.id = p.vertical_pack_id
      order by vp.key
    `;
    expect(packs.map((p) => p.key)).toEqual([
      "medical-aesthetics",
      "real-estate-agent",
    ]);

    // Compliance rules resolve per project — the surgeon gets medical rules
    const medicalRules = await onboarding.complianceRulesFor(surgeon.data.projectId);
    expect(medicalRules.some((r) => r.id === "no-phi")).toBe(true);
    const realtorRules = await onboarding.complianceRulesFor(realtor.data.projectId);
    expect(realtorRules.some((r) => r.id === "fair-housing")).toBe(true);

    // Each client's prompts mention only its own market
    const surgeonPrompts = await sql`
      select text from prompts where prompt_set_id = ${surgeon.data.promptSetId}
    `;
    expect(
      surgeonPrompts.every((p) => !(p.text as string).includes("Jersey City"))
    ).toBe(true);
    expect(
      surgeonPrompts.some((p) => (p.text as string).includes("rhinoplasty"))
    ).toBe(true);
  });

  it("reuses one pinned pack row across clients on the same version", async () => {
    await onboarding.onboardClient(user, realtorInput);
    await onboarding.onboardClient(user, {
      ...realtorInput,
      clientName: "Second Realtor",
      company: { name: "Second Realty", aliases: [], domain: "second.com" },
    });
    const [count] = await sql`
      select count(*)::int as n from vertical_packs where key = 'real-estate-agent'
    `;
    expect(count?.n).toBe(1);
  });
});
