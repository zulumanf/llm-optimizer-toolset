/**
 * Spec 145D — on a third-party profile page, only claims about the client's
 * recorded identity are stored as proposed; everything else is rejected and
 * never inserted. Runs against a real database with a stub extraction agent.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { seedTestActors } from "../helpers/actors";
import { truncateAll } from "../helpers/db";

const TEST_URL = process.env.TEST_DATABASE_URL;

const user: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000901",
  email: "op@test.local",
  name: "Operator",
  role: "operator",
};

function stubCaller(claims: unknown[]) {
  return async () => ({
    text: JSON.stringify({ claims }),
    tokensIn: 100,
    tokensOut: 50,
  });
}

const PROFILE_HTML = `<html><head><title>Agent directory</title></head><body>
<h1>Ana Perez</h1>
<p>Ana Perez is an agent with Perez Realty Group in Jersey City.</p>
<p>Other Agent closed 12 homes in Hoboken.</p>
<p>Greystar manages The James in Jersey City.</p>
</body></html>`;

function draft(subject: string, wording: string, category = "general") {
  return {
    subject,
    predicate: "states",
    object: "",
    originalWording: wording,
    normalizedWording: wording,
    category,
    asOf: null,
    value: null,
    confidence: 0.9,
    locator: "",
  };
}

describe.skipIf(!TEST_URL)("profile claim subject filtering (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let projectSvc: typeof import("@/lib/projects/service");
  let ingest: typeof import("@/lib/knowledge/sources/ingest");
  let entities: typeof import("@/lib/knowledge/entities/service");
  let extraction: typeof import("@/lib/knowledge/extraction/claims");
  let identity: typeof import("@/lib/knowledge/entities/subject-identity");

  let projectA = "";
  let projectB = "";

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    await truncateAll(sql);
    projectSvc = await import("@/lib/projects/service");
    ingest = await import("@/lib/knowledge/sources/ingest");
    entities = await import("@/lib/knowledge/entities/service");
    extraction = await import("@/lib/knowledge/extraction/claims");
    identity = await import("@/lib/knowledge/entities/subject-identity");
    await seedTestActors(sql);
  }, 180_000);

  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    await sql.unsafe(`
      truncate source_normalizations, extraction_runs, extracted_documents,
        claim_contradictions, claim_versions, entity_aliases, entity_relationships,
        claims, source_artifacts, knowledge_entities, evidence, jobs,
        domain_events, audit_log, projects, companies
      restart identity cascade
    `);
    const a = await projectSvc.createProject(user, { name: "Perez Realty" });
    const b = await projectSvc.createProject(user, { name: "Rival Realty" });
    if (!a.ok || !b.ok) throw new Error("project setup failed");
    projectA = a.data.id;
    projectB = b.data.id;

    const [company] = await sql`
      insert into companies (name, aliases, domain, is_self)
      values ('Perez Realty Group', ${["Perez Realty"]}, 'perezrealty.example', true)
      returning id
    `;
    await sql`update projects set subject_company_id = ${company!.id} where id = ${projectA}`;

    await entities.upsertEntity(user, {
      projectId: projectA,
      entityType: "person",
      canonicalName: "Ana Perez",
    });
    // Another client's person, who must never widen client A's identity.
    await entities.upsertEntity(user, {
      projectId: projectB,
      entityType: "person",
      canonicalName: "Other Agent",
    });
  });

  it("builds client A's identity from its own records only", async () => {
    const lookup = await identity.loadClientSubjectIdentity(projectA);
    expect(lookup.status).toBe("resolved");
    if (lookup.status !== "resolved") return;
    const allow = identity.subjectAllowListFor(lookup.identity);
    expect(allow).toEqual(["Perez Realty Group", "Perez Realty", "Ana Perez"]);
    expect(allow).not.toContain("Other Agent");

    expect(await identity.loadClientSubjectIdentity(projectB)).toEqual({
      status: "no_subject_company",
    });
  });

  it("stores only in-scope claims as proposed and inserts nothing for other subjects", async () => {
    const source = await ingest.ingestSource(user, {
      projectId: projectA,
      sourceType: "website",
      origin: "url_fetch",
      url: "https://directory.example.com/ana-perez",
      filename: "profile.html",
      bytes: Buffer.from(PROFILE_HTML, "utf8"),
      privacy: "public",
    });
    expect(source.ok).toBe(true);
    if (!source.ok) return;

    const lookup = await identity.loadClientSubjectIdentity(projectA);
    if (lookup.status !== "resolved") throw new Error("identity not resolved");

    const result = await extraction.extractClaimsFromSource(
      user,
      {
        sourceArtifactId: source.data.sourceArtifactId,
        subjectAllowList: identity.subjectAllowListFor(lookup.identity),
      },
      {
        caller: stubCaller([
          draft(
            "Ana Perez",
            "Ana Perez is an agent with Perez Realty Group in Jersey City.",
            "affiliation"
          ),
          draft("Other Agent", "Other Agent closed 12 homes in Hoboken.", "transaction"),
          draft("Greystar", "Greystar manages The James in Jersey City."),
          // About the client, but fabricated: the verbatim guard still applies.
          draft("Perez Realty Group", "Perez Realty Group closed 500 homes in 2025.", "transaction"),
        ]),
      }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.proposed.map((c) => c.subject)).toEqual(["Ana Perez"]);
    const reasons = Object.fromEntries(result.data.rejected.map((r) => [r.wording, r.reason]));
    expect(reasons["Other Agent closed 12 homes in Hoboken."]).toContain("is not this client");
    expect(reasons["Greystar manages The James in Jersey City."]).toContain("is not this client");
    expect(reasons["Perez Realty Group closed 500 homes in 2025."]).toContain(
      "does not appear in the source"
    );

    const rows = await sql`
      select subject_entity, status, source_artifact_ids from claims where project_id = ${projectA}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.subjectEntity).toBe("Ana Perez");
    expect(rows[0]!.status).toBe("proposed");
    expect(rows[0]!.sourceArtifactIds).toEqual([source.data.sourceArtifactId]);

    const [evidence] = await sql`
      select count(*)::int as n from evidence where project_id = ${projectA}
    `;
    expect(evidence!.n).toBe(1);
    const [foreign] = await sql`
      select count(*)::int as n from claims where subject_entity in ('Other Agent', 'Greystar')
    `;
    expect(foreign!.n).toBe(0);
  });
});
