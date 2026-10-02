/**
 * Spec 145E — cross-artifact claim de-duplication against a real database:
 * SQL, advisory locking, claim_versions immutability and concurrency. Runs
 * only when TEST_DATABASE_URL is set; uses a stub agent (no model, no spend).
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
  return async () => ({ text: JSON.stringify({ claims }), tokensIn: 100, tokensOut: 50 });
}

const FACT = "Ana Perez closed 40 homes in 2025.";

function page(extra: string): string {
  return `<html><body><p>${FACT}</p><p>Luis Perez closed 40 homes in 2025.</p>
<p>Ana Perez closed 42 homes in 2025.</p><p>${extra}</p></body></html>`;
}

function draft(over: Record<string, unknown> = {}) {
  return {
    subject: "Ana Perez",
    predicate: "closed",
    object: "40 homes",
    originalWording: FACT,
    normalizedWording: FACT,
    category: "transaction",
    asOf: "2025-12-31",
    value: 40,
    confidence: 0.9,
    locator: "",
    ...over,
  };
}

describe.skipIf(!TEST_URL)("cross-artifact claim de-duplication (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let projectSvc: typeof import("@/lib/projects/service");
  let claimSvc: typeof import("@/lib/claims/service");
  let ingest: typeof import("@/lib/knowledge/sources/ingest");
  let extraction: typeof import("@/lib/knowledge/extraction/claims");

  let projectA = "";
  let projectB = "";

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    await truncateAll(sql);
    projectSvc = await import("@/lib/projects/service");
    claimSvc = await import("@/lib/claims/service");
    ingest = await import("@/lib/knowledge/sources/ingest");
    extraction = await import("@/lib/knowledge/extraction/claims");
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
        domain_events, audit_log, projects
      restart identity cascade
    `);
    const a = await projectSvc.createProject(user, { name: "Perez Realty" });
    const b = await projectSvc.createProject(user, { name: "Rival Realty" });
    if (!a.ok || !b.ok) throw new Error("project setup failed");
    projectA = a.data.id;
    projectB = b.data.id;
  });

  async function artifact(projectId: string, version: string, privacy = "public") {
    const source = await ingest.ingestSource(user, {
      projectId,
      sourceType: "website",
      origin: "url_fetch",
      url: `https://directory.example.com/ana-${privacy}`,
      filename: "profile.html",
      bytes: Buffer.from(page(version), "utf8"),
      privacy,
    });
    if (!source.ok) throw new Error(source.error.message);
    return source.data.sourceArtifactId;
  }

  async function extract(sourceArtifactId: string, drafts: unknown[] = [draft()]) {
    const result = await extraction.extractClaimsFromSource(
      user,
      { sourceArtifactId },
      { caller: stubCaller(drafts) }
    );
    if (!result.ok) throw new Error(result.error.message);
    return result.data;
  }

  const claimsOf = (projectId: string) =>
    sql`select id, status, evidence_ids, source_artifact_ids, updated_at from claims
        where project_id = ${projectId} order by created_at`;

  it("links the same fact from a newer artifact to the existing proposal", async () => {
    const v1 = await artifact(projectA, "v1");
    const first = await extract(v1);
    const v2 = await artifact(projectA, "v2");
    const second = await extract(v2);

    expect(first.proposed).toHaveLength(1);
    expect(second.proposed).toEqual([]);
    expect(second.matched).toHaveLength(1);
    expect(second.matched[0]).toMatchObject({
      claimId: first.proposed[0]!.claimId,
      existingStatus: "proposed",
      resolution: "linked",
    });

    const rows = await claimsOf(projectA);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.evidenceIds).toHaveLength(2);
    expect(rows[0]!.evidenceIds).toContain(second.matched[0]!.evidenceId);
    expect(rows[0]!.sourceArtifactIds).toEqual([v1, v2]);

    const [events] = await sql`
      select count(*)::int as n from domain_events where type = 'claim.proposed'
    `;
    expect(events!.n).toBe(1);
  });

  it("leaves an approved claim and its claim_versions untouched, keeping the new evidence", async () => {
    const first = await extract(await artifact(projectA, "v1"));
    const claimId = first.proposed[0]!.claimId;
    expect((await claimSvc.approveClaim(user, { claimId })).ok).toBe(true);
    const [before] = await claimsOf(projectA);
    const versionsBefore = await sql`select * from claim_versions where claim_id = ${claimId}`;

    const v2 = await artifact(projectA, "v2");
    const second = await extract(v2);

    expect(second.proposed).toEqual([]);
    expect(second.matched[0]).toMatchObject({ claimId, existingStatus: "approved", resolution: "already_known" });
    const rows = await claimsOf(projectA);
    expect(rows).toEqual([before]);
    expect(await sql`select * from claim_versions where claim_id = ${claimId}`).toEqual(versionsBefore);
    const [evidence] = await sql`
      select ref_id from evidence where id = ${second.matched[0]!.evidenceId}
    `;
    expect(evidence!.refId).toBe(v2);
  });

  it.each([["rejected"], ["superseded"]])("does not re-propose a %s claim", async (status) => {
    const first = await extract(await artifact(projectA, "v1"));
    await sql`update claims set status = ${status} where id = ${first.proposed[0]!.claimId}`;
    const [before] = await claimsOf(projectA);

    const second = await extract(await artifact(projectA, "v2"));
    expect(second.proposed).toEqual([]);
    expect(second.matched[0]).toMatchObject({ existingStatus: status, resolution: "already_known" });
    expect(await claimsOf(projectA)).toEqual([before]);
  });

  it("never matches another project's identical fact", async () => {
    const b = await extract(await artifact(projectB, "v1"));
    const a = await extract(await artifact(projectA, "v1"));
    expect(a.matched).toEqual([]);
    expect(a.proposed).toHaveLength(1);
    const [rowB] = await claimsOf(projectB);
    expect(rowB!.id).toBe(b.proposed[0]!.claimId);
    expect(rowB!.evidenceIds).toHaveLength(1);
  });

  it("inserts a changed value as a new proposal", async () => {
    const first = await extract(await artifact(projectA, "v1"));
    await claimSvc.approveClaim(user, { claimId: first.proposed[0]!.claimId });
    const second = await extract(await artifact(projectA, "v2"), [
      draft({
        value: 42,
        object: "42 homes",
        originalWording: "Ana Perez closed 42 homes in 2025.",
        normalizedWording: "Ana Perez closed 42 homes in 2025.",
      }),
    ]);
    expect(second.matched).toEqual([]);
    expect(second.proposed).toHaveLength(1);
    expect(await claimsOf(projectA)).toHaveLength(2);
  });

  it("never hides a contradiction the existing detector flags", async () => {
    // The detector flags value divergence when the statements agree and the
    // values do not. Same statement + different value is a different identity,
    // so it must be inserted and flagged, not matched away.
    const first = await extract(await artifact(projectA, "v1"));
    await claimSvc.approveClaim(user, { claimId: first.proposed[0]!.claimId });
    const second = await extract(await artifact(projectA, "v2"), [draft({ value: 41 })]);
    expect(second.matched).toEqual([]);
    expect(second.proposed).toHaveLength(1);
    expect(second.contradictionsDetected).toBeGreaterThanOrEqual(1);
    const [row] = await sql`
      select count(*)::int as n from claim_contradictions
      where claim_id = any(${[first.proposed[0]!.claimId, second.proposed[0]!.claimId]})
         or contradicting_claim_id = any(${[first.proposed[0]!.claimId, second.proposed[0]!.claimId]})
    `;
    expect(row!.n).toBeGreaterThanOrEqual(1);
  });

  it("inserts a changed as-of date and a different subject as new proposals", async () => {
    await extract(await artifact(projectA, "v1"));
    const second = await extract(await artifact(projectA, "v2"), [
      draft({ asOf: "2026-06-30" }),
      draft({
        subject: "Luis Perez",
        originalWording: "Luis Perez closed 40 homes in 2025.",
        normalizedWording: "Luis Perez closed 40 homes in 2025.",
      }),
    ]);
    expect(second.matched).toEqual([]);
    expect(second.proposed).toHaveLength(2);
    expect(await claimsOf(projectA)).toHaveLength(3);
  });

  it("does not link across a privacy class", async () => {
    const first = await extract(await artifact(projectA, "v1", "public"));
    const second = await extract(await artifact(projectA, "v2", "client_only"));
    expect(second.matched).toEqual([]);
    expect(second.proposed).toHaveLength(1);
    const [publicRow] = await sql`select evidence_ids from claims where id = ${first.proposed[0]!.claimId}`;
    expect(publicRow!.evidenceIds).toHaveLength(1);
  });

  it("keeps the subject allow list and verbatim guard ahead of matching", async () => {
    await extract(await artifact(projectA, "v1"));
    const result = await extraction.extractClaimsFromSource(
      user,
      { sourceArtifactId: await artifact(projectA, "v2"), subjectAllowList: ["Luis Perez"] },
      { caller: stubCaller([draft(), draft({ subject: "Luis Perez", originalWording: "Luis Perez closed 400 homes." })]) }
    );
    if (!result.ok) throw new Error(result.error.message);
    expect(result.data.matched).toEqual([]);
    expect(result.data.proposed).toEqual([]);
    expect(result.data.rejected).toHaveLength(2);
  });

  it("creates one claim when two artifacts are extracted concurrently", async () => {
    const v1 = await artifact(projectA, "v1");
    const v2 = await artifact(projectA, "v2");
    const [x, y] = await Promise.all([extract(v1), extract(v2)]);
    expect(x.proposed.length + y.proposed.length).toBe(1);
    expect(x.matched.length + y.matched.length).toBe(1);
    const rows = await claimsOf(projectA);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.evidenceIds).toHaveLength(2);
  });
});
