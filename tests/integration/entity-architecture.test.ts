/**
 * Spec 056: the inert relationship schema gets its write path (propose →
 * approve → the groups rollup returns non-empty for the first time),
 * company names scope by market, and merges are non-destructive, guarded,
 * and reversible.
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
  id: "00000000-0000-4000-8000-0000000000ef",
  email: "op@test.local",
  name: "Op",
  role: "operator",
};
const admin: CurrentUser = {
  id: "00000000-0000-4000-8000-0000000000ee",
  email: "admin@test.local",
  name: "Admin",
  role: "admin",
};

describe.skipIf(!TEST_URL)("entity architecture (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let companySvc: typeof import("@/lib/companies/service");
  let entities: typeof import("@/lib/knowledge/entities/service");
  let groups: typeof import("@/lib/competitors/groups");
  let exclusivity: typeof import("@/lib/exclusivity/service");

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    companySvc = await import("@/lib/companies/service");
    entities = await import("@/lib/knowledge/entities/service");
    groups = await import("@/lib/competitors/groups");
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
      `truncate audit_log, entity_relationships, entity_aliases,
       knowledge_entities, prospects, market_launches, scores, runs,
       prompt_set_versions, prompt_sets, competitors, companies, markets,
       projects cascade`
    );
  });

  afterAll(async () => {
    await sql.end();
  });

  async function seedCompany(name: string, marketId?: string | null): Promise<string> {
    const created = unwrap(
      await companySvc.upsertCompany(operator, {
        name,
        aliases: [],
        ...(marketId !== undefined ? { marketId } : {}),
      })
    );
    return created.id;
  }

  /** Project measuring both companies, with one scored run (raw seed). */
  async function seedMeasuredProject(
    companyIds: string[]
  ): Promise<string> {
    const [project] = await sql`
      insert into projects (name) values ('Rel Test') returning id
    `;
    await sql`
      update projects set subject_company_id = ${companyIds[0]} where id = ${project!.id}
    `;
    for (const companyId of companyIds.slice(1)) {
      await sql`
        insert into competitors (project_id, company_id, tier)
        values (${project!.id}, ${companyId}, 'primary')
      `;
    }
    const [set] = await sql`
      insert into prompt_sets (project_id, name) values (${project!.id}, 's')
      returning id
    `;
    const [version] = await sql`
      insert into prompt_set_versions (prompt_set_id, version, frozen_prompts)
      values (${set!.id}, 1, '[]') returning id
    `;
    const [run] = await sql`
      insert into runs (project_id, prompt_set_version_id, label, providers,
        trigger, budget_usd)
      values (${project!.id}, ${version!.id}, 'r', '[]', 'manual', 1)
      returning id
    `;
    for (const companyId of companyIds) {
      await sql`
        insert into scores (run_id, company_id, metric, provider, value,
          sample_size, scoring_version)
        values (${run!.id}, ${companyId}, 'mention_rate', 'all', 0.4, 40, 'v1.1')
      `;
    }
    return project!.id as string;
  }

  it("propose → approve makes the groups rollup non-empty for the first time", async () => {
    const team = await seedCompany("Rivera Team");
    const brokerage = await seedCompany("Compass");
    const projectId = await seedMeasuredProject([team, brokerage]);

    // Before: schema exists, rollup is empty — the audit's inert P0.
    expect(await groups.relationshipGroups(projectId)).toEqual([]);

    const proposed = unwrap(
      await entities.proposeRelationship(operator, {
        projectId,
        fromCompanyId: team,
        toCompanyId: brokerage,
        relationshipType: "brokerage",
      })
    );
    // Proposed does not group — approval is the human decision.
    expect(await groups.relationshipGroups(projectId)).toEqual([]);

    // A duplicate open proposal refuses.
    const dup = await entities.proposeRelationship(operator, {
      projectId,
      fromCompanyId: team,
      toCompanyId: brokerage,
      relationshipType: "brokerage",
    });
    expect(dup.ok).toBe(false);

    unwrap(
      await entities.reviewRelationship(operator, {
        relationshipId: proposed.relationshipId,
        decision: "approved",
      })
    );
    const grouped = await groups.relationshipGroups(projectId);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]!.parentName).toBe("Compass");
    expect(grouped[0]!.members.map((m) => m.name)).toEqual(["Rivera Team"]);
    expect(grouped[0]!.members[0]!.mentionRate).toBeCloseTo(0.4, 3);

    // Audit trail exists for propose + approve.
    const audits = await sql`
      select action from audit_log where entity = 'entity_relationship'
      order by at asc
    `;
    expect(audits.map((a) => a.action)).toEqual([
      "entity.relationship_proposed",
      "entity.relationship_approved",
    ]);
  });

  it("effective dating: an ended affiliation stops grouping; a successor can be proposed", async () => {
    const team = await seedCompany("Rivera Team");
    const oldBrokerage = await seedCompany("Compass");
    const projectId = await seedMeasuredProject([team, oldBrokerage]);

    const rel = unwrap(
      await entities.proposeRelationship(operator, {
        projectId,
        fromCompanyId: team,
        toCompanyId: oldBrokerage,
        relationshipType: "brokerage",
      })
    );
    unwrap(
      await entities.reviewRelationship(operator, {
        relationshipId: rel.relationshipId,
        decision: "approved",
      })
    );
    expect(await groups.relationshipGroups(projectId)).toHaveLength(1);

    // The team moves brokerages: end date, never an edit.
    unwrap(
      await entities.endRelationship(operator, {
        relationshipId: rel.relationshipId,
        effectiveUntil: "2020-01-01",
      })
    );
    expect(await groups.relationshipGroups(projectId)).toEqual([]);

    // Both rows survive as history; a successor proposal is now allowed.
    const successor = await entities.proposeRelationship(operator, {
      projectId,
      fromCompanyId: team,
      toCompanyId: oldBrokerage,
      relationshipType: "brokerage",
    });
    expect(successor.ok).toBe(true);
    const [count] = await sql`
      select count(*)::int as n from entity_relationships
    `;
    expect(count?.n).toBe(2);
  });

  it("rejection keeps history and never groups", async () => {
    const team = await seedCompany("Rivera Team");
    const brokerage = await seedCompany("Compass");
    const projectId = await seedMeasuredProject([team, brokerage]);
    const rel = unwrap(
      await entities.proposeRelationship(operator, {
        projectId,
        fromCompanyId: team,
        toCompanyId: brokerage,
        relationshipType: "works_for",
      })
    );
    unwrap(
      await entities.reviewRelationship(operator, {
        relationshipId: rel.relationshipId,
        decision: "rejected",
      })
    );
    expect(await groups.relationshipGroups(projectId)).toEqual([]);
    const [row] = await sql`
      select status from entity_relationships where id = ${rel.relationshipId}
    `;
    expect(row?.status).toBe("rejected");
  });

  it("market scoping: same name coexists across markets, refuses within one", async () => {
    const miami = unwrap(
      await exclusivity.createMarket(admin, { name: "Miami", kind: "city", aliases: [] })
    );
    const austin = unwrap(
      await exclusivity.createMarket(admin, { name: "Austin", kind: "city", aliases: [] })
    );

    await seedCompany("Smith Group", miami.marketId);
    // The audit's structurally-unrepresentable case, now representable:
    const second = await companySvc.upsertCompany(operator, {
      name: "Smith Group",
      aliases: [],
      marketId: austin.marketId,
    });
    expect(second.ok).toBe(true);

    // Same market still refuses.
    const sameMarket = await companySvc.upsertCompany(operator, {
      name: "Smith Group",
      aliases: [],
      marketId: miami.marketId,
    });
    expect(sameMarket.ok).toBe(false);

    // The global (null-market) bucket keeps its own uniqueness.
    await seedCompany("Global Co");
    const globalDup = await companySvc.upsertCompany(operator, {
      name: "Global Co",
      aliases: [],
    });
    expect(globalDup.ok).toBe(false);

    // Cross-market same names reach the resolver as a tie → possible.
    const { resolveProspectCompany } = await import("@/lib/prospects/resolve");
    const all = await sql`
      select id, name, aliases, domain from companies
      where lower(name) = 'smith group' and archived_at is null
    `;
    const resolution = resolveProspectCompany(
      { businessName: "Smith Group" },
      all.map((c) => ({
        id: c.id as string,
        name: c.name as string,
        aliases: (c.aliases as string[]) ?? [],
        domain: (c.domain as string | null) ?? null,
      }))
    );
    expect(resolution.verdict).toBe("possible");
    expect(resolution.companyId).toBeNull();
  });

  it("merge: aliases move, references repoint, history stays, chain resolves; unmerge restores", async () => {
    const keep = unwrap(
      await companySvc.upsertCompany(operator, {
        name: "Hudson Advisory",
        aliases: ["HA"],
      })
    );
    const dupe = unwrap(
      await companySvc.upsertCompany(operator, {
        name: "Hudson Advisory Team NYC",
        aliases: ["HAT NYC"],
      })
    );
    const projectId = await seedMeasuredProject([keep.id, dupe.id]);

    // A prospect pointing at the duplicate.
    const market = unwrap(
      await exclusivity.createMarket(admin, { name: "Manhattan", kind: "borough", aliases: [] })
    );
    const [launch] = await sql`
      insert into market_launches (name, market_id)
      values ('Manhattan luxury', ${market.marketId}) returning id
    `;
    const [prospect] = await sql`
      insert into prospects (launch_id, business_name, prospect_type, company_id)
      values (${launch!.id}, 'Hudson Advisory Team NYC', 'team', ${dupe.id})
      returning id
    `;

    const merged = unwrap(
      await companySvc.mergeCompanies(admin, {
        fromId: dupe.id,
        intoId: keep.id,
        reason: "Same firm — duplicate minted before spec 050's resolver fix.",
      })
    );
    expect(merged.movedAliases).toContain("Hudson Advisory Team NYC");
    expect(merged.movedAliases).toContain("HAT NYC");

    const [survivor] = await sql`select aliases from companies where id = ${keep.id}`;
    expect(survivor?.aliases).toContain("Hudson Advisory Team NYC");
    const [gone] = await sql`
      select merged_into, archived_at from companies where id = ${dupe.id}
    `;
    expect(gone?.mergedInto).toBe(keep.id);
    expect(gone?.archivedAt).not.toBeNull();

    const [repointed] = await sql`
      select company_id from prospects where id = ${prospect!.id}
    `;
    expect(repointed?.companyId).toBe(keep.id);
    // The duplicate's competitor row re-tracked (survivor already subject —
    // its own row untouched; the dupe's tracking row must not linger).
    const [lingering] = await sql`
      select count(*)::int as n from competitors
      where project_id = ${projectId} and company_id = ${dupe.id}
    `;
    expect(lingering?.n).toBe(0);

    // History stays where it was measured.
    const [historic] = await sql`
      select count(*)::int as n from scores where company_id = ${dupe.id}
    `;
    expect(historic?.n).toBeGreaterThan(0);

    expect(await companySvc.resolveCompanyId(dupe.id)).toBe(keep.id);

    // Guards: double-merge and self-merge refuse.
    const again = await companySvc.mergeCompanies(admin, {
      fromId: dupe.id,
      intoId: keep.id,
      reason: "duplicate attempt should refuse",
    });
    expect(again.ok).toBe(false);

    // Unmerge restores the row and the exact moved aliases.
    const restored = unwrap(
      await companySvc.unmergeCompany(admin, {
        companyId: dupe.id,
        reason: "They are different firms after all.",
      })
    );
    expect(restored.restoredAliases).toContain("HAT NYC");
    const [back] = await sql`
      select merged_into, archived_at, aliases from companies where id = ${dupe.id}
    `;
    expect(back?.mergedInto).toBeNull();
    expect(back?.archivedAt).toBeNull();
    expect(back?.aliases).toContain("HAT NYC");
    const [cleaned] = await sql`select aliases from companies where id = ${keep.id}`;
    expect(cleaned?.aliases).not.toContain("HAT NYC");
    expect(cleaned?.aliases).toContain("HA");
  });

  it("merging two active client subjects refuses — that would merge two clients", async () => {
    const a = await seedCompany("Client Subject A");
    const b = await seedCompany("Client Subject B");
    for (const [name, subject] of [
      ["Client A", a],
      ["Client B", b],
    ] as const) {
      const [project] = await sql`
        insert into projects (name) values (${name}) returning id
      `;
      await sql`
        update projects set subject_company_id = ${subject} where id = ${project!.id}
      `;
    }
    const refused = await companySvc.mergeCompanies(admin, {
      fromId: a,
      intoId: b,
      reason: "should refuse — both are client subjects",
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toMatch(/two clients/);
  });
});
