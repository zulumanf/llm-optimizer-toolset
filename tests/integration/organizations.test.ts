/**
 * Spec 151 D1: a synthetic brokerage sees an authorized portfolio of
 * agent-level market-benchmark estimates — and nothing else.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { truncateAll } from "../helpers/db";
import { clientViewerUser, operatorUser } from "../helpers/actors";
import type { CurrentUser } from "@/lib/auth";

const TEST_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_URL)("brokerage organizations (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let orgs: typeof import("@/lib/organizations/service");
  let scoring: typeof import("@/lib/scoring/compute");
  const staff = operatorUser();
  const brokerUser = clientViewerUser();
  const otherUser: CurrentUser = { ...clientViewerUser(), id: "00000000-0000-4000-8000-00000000b001", email: "other@client.test", name: "Other client" };
  let agentA: string;
  let agentB: string;
  let outsider: string;

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    orgs = await import("@/lib/organizations/service");
    scoring = await import("@/lib/scoring/compute");
  });
  afterAll(async () => {
    await sql.end();
  });

  async function scoredRun(projectId: string, mentionedIds: string[], recommendAll = false): Promise<void> {
    const [set] = await sql`insert into prompt_sets (project_id, name) values (${projectId}, 'S') returning id`;
    const [version] = await sql`insert into prompt_set_versions (prompt_set_id, version, frozen_prompts) values (${set!.id}, 1, '[]') returning id`;
    const [run] = await sql`
      insert into runs (project_id, prompt_set_version_id, label, providers, status, trigger, budget_usd)
      values (${projectId}, ${version!.id}, 'bench', '[]', 'completed', 'manual', 1) returning id
    `;
    for (let p = 0; p < 6; p += 1) {
      const [resp] = await sql`
        insert into responses (run_id, prompt_id, prompt_text, provider, model, repetition, response_text)
        values (${run!.id}, gen_random_uuid(), 'best agent in Springfield?', 'openai', 'm1', 1, 'a') returning id
      `;
      for (const id of mentionedIds) {
        await sql`
          insert into mentions (response_id, company_id, mentioned, recommended, parser_version, confidence)
          values (${resp!.id}, ${id}, true, ${recommendAll || p % 2 === 0}, 'mention-parser-v2+llm', 0.9)
        `;
      }
    }
    await scoring.computeScores(run!.id as string);
  }

  beforeEach(async () => {
    await truncateAll(sql);
    await sql`insert into users (id, email, name, role) values (${otherUser.id}, ${otherUser.email}, 'Other', 'client_viewer') on conflict do nothing`;
    const [market] = await sql`insert into markets (name, kind) values ('Springfield', 'city') returning id`;
    const [a] = await sql`insert into companies (name) values ('Agent A Team') returning id`;
    const [b] = await sql`insert into companies (name) values ('Agent B') returning id`;
    const [o] = await sql`insert into companies (name) values ('Unrelated Client Co') returning id`;
    agentA = a!.id as string;
    agentB = b!.id as string;
    outsider = o!.id as string;
    // Market benchmark project (readable by the roster).
    const [bench] = await sql`insert into projects (name, kind, market_id) values ('Market benchmark: Springfield', 'prospect', ${market!.id}) returning id`;
    await scoredRun(bench!.id as string, [agentA, agentB, outsider]);
    // A private client project that also measures Agent A — must never be read.
    const [client] = await sql`insert into projects (name, subject_company_id) values ('Private client', ${outsider}) returning id`;
    // Newer and 6/6 recommended: if the roster read it, Agent A would show 1.0.
    await scoredRun(client!.id as string, [agentA], true);
  });

  it("shows granted members' benchmark estimates, with intervals, and nothing else", async () => {
    const created = await orgs.createOrganization(staff, { name: "Springfield Realty" });
    if (!created.ok) throw new Error(created.error.message);
    const orgId = created.data.organizationId;
    await orgs.addOrganizationEntity(staff, { organizationId: orgId, companyId: agentA, level: "team" });
    await orgs.addOrganizationEntity(staff, { organizationId: orgId, companyId: agentB, level: "individual" });

    // No grant yet: deny by default, indistinguishable from not existing.
    await expect(orgs.organizationRoster(brokerUser, orgId)).rejects.toThrow(/not found/i);
    expect(await orgs.visibleOrganizations(brokerUser)).toEqual([]);

    expect((await orgs.grantOrganizationAccess(brokerUser, { organizationId: orgId, userId: brokerUser.id })).ok).toBe(false);
    expect((await orgs.grantOrganizationAccess(staff, { organizationId: orgId, userId: brokerUser.id })).ok).toBe(true);

    const roster = await orgs.organizationRoster(brokerUser, orgId);
    expect(roster.rows.map((r) => r.name)).toEqual(["Agent A Team", "Agent B"]);
    expect(roster.rows.some((r) => r.companyId === outsider)).toBe(false);
    const a = roster.rows[0]!;
    expect(a.market).toBe("Springfield");
    expect(a.recommended[0]).toMatchObject({ numerator: 3, denominator: 6, rate: 0.5, prompts: 6 });
    expect(a.recommended[0]!.low).not.toBeNull();

    // Another client account cannot see it; a bogus id reads as not found.
    await expect(orgs.organizationRoster(otherUser, orgId)).rejects.toThrow(/not found/i);
    await expect(orgs.organizationRoster(staff, "00000000-0000-4000-8000-0000000000ff")).rejects.toThrow(/not found/i);
    // Server-side scope: a company measured only in a private client project
    // cannot join a roster, whatever the form offered.
    const [privateOnly] = await sql`insert into companies (name) values ('Private Only Co') returning id`;
    const refused = await orgs.addOrganizationEntity(staff, { organizationId: orgId, companyId: privateOnly!.id, level: "team" });
    expect(refused.ok).toBe(false);
    // Brokerage users stay read-only.
    expect((await orgs.addOrganizationEntity(brokerUser, { organizationId: orgId, companyId: outsider, level: "individual" })).ok).toBe(false);
  });
});
