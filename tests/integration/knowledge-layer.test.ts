/**
 * Integration tests for specs 020-024 — the knowledge compilation and context
 * engineering layer.
 *
 * Covers the full chain: ingest → extract → propose → approve → compile →
 * incremental rebuild → context packet, plus the client-isolation tests that
 * matter most (this is the layer where cross-client leakage would happen).
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { seedTestActors } from "../helpers/actors";

const TEST_URL = process.env.TEST_DATABASE_URL;
const ROOT = join(__dirname, "..", "..");

const user: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000901",
  email: "op@test.local",
  name: "Operator",
  role: "operator",
};

/** A deterministic stand-in for the extraction agent — no network, no spend. */
function stubCaller(claims: unknown[]) {
  return async () => ({
    text: JSON.stringify({ claims }),
    tokensIn: 100,
    tokensOut: 50,
  });
}

const WEBSITE_HTML = `<html><head><title>Northvale Demo</title></head><body>
<h1>Northvale Demo Group</h1>
<p>Northvale Demo operates in Jersey City and Hoboken.</p>
<p>The team specialises in waterfront condominiums.</p>
<p>Northvale Demo closed 40 homes in 2025.</p>
</body></html>`;

describe.skipIf(!TEST_URL)("knowledge compilation layer (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let projectSvc: typeof import("@/lib/projects/service");
  let claimSvc: typeof import("@/lib/claims/service");
  let ingest: typeof import("@/lib/knowledge/sources/ingest");
  let entities: typeof import("@/lib/knowledge/entities/service");
  let instructions: typeof import("@/lib/knowledge/instructions/service");
  let extraction: typeof import("@/lib/knowledge/extraction/claims");
  let contradictions: typeof import("@/lib/knowledge/contradictions/detect");
  let planner: typeof import("@/lib/knowledge/build/planner");
  let stale: typeof import("@/lib/knowledge/build/stale");
  let compile: typeof import("@/lib/knowledge/compiler/compile");
  let builder: typeof import("@/lib/knowledge/context/builder");
  let templates: typeof import("@/lib/knowledge/context/templates");
  let experiment: typeof import("@/lib/knowledge/context/experiment");

  let projectA = "";
  let projectB = "";

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    projectSvc = await import("@/lib/projects/service");
    claimSvc = await import("@/lib/claims/service");
    ingest = await import("@/lib/knowledge/sources/ingest");
    entities = await import("@/lib/knowledge/entities/service");
    instructions = await import("@/lib/knowledge/instructions/service");
    extraction = await import("@/lib/knowledge/extraction/claims");
    contradictions = await import("@/lib/knowledge/contradictions/detect");
    planner = await import("@/lib/knowledge/build/planner");
    stale = await import("@/lib/knowledge/build/stale");
    compile = await import("@/lib/knowledge/compiler/compile");
    builder = await import("@/lib/knowledge/context/builder");
    templates = await import("@/lib/knowledge/context/templates");
    experiment = await import("@/lib/knowledge/context/experiment");

    await sql.unsafe("drop schema public cascade; create schema public;");
    execSync(`npx tsx scripts/migrate.ts up --db "${TEST_URL}"`, {
      cwd: ROOT,
      stdio: "pipe",
    });
    await seedTestActors(sql);
    await templates.syncPacketTemplates();
  }, 180_000);

  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    await sql.unsafe(`
      truncate context_packet_items, evidence_packets, knowledge_build_manifests,
        knowledge_build_items, knowledge_builds, wiki_annotations,
        wiki_section_provenance, wiki_sections, wiki_page_dependencies,
        wiki_page_versions, wiki_pages, source_normalizations, extraction_runs,
        extracted_documents, claim_contradictions, claim_versions,
        knowledge_instruction_versions, knowledge_instructions, entity_aliases,
        entity_relationships, claims, source_artifacts, knowledge_entities,
        evidence, jobs, domain_events, audit_log, projects
      restart identity cascade
    `);
    const a = await projectSvc.createProject(user, { name: "Northvale Demo" });
    const b = await projectSvc.createProject(user, { name: "Hudson Rivals" });
    if (!a.ok || !b.ok) throw new Error("project setup failed");
    projectA = a.data.id;
    projectB = b.data.id;
  });

  // ------------------------------------------------------------- ingestion

  it("stores a source content-addressed, extracts it, and dedupes identical bytes", async () => {
    const first = await ingest.ingestSource(user, {
      projectId: projectA,
      sourceType: "website",
      origin: "upload",
      filename: "jcluxury.html",
      bytes: Buffer.from(WEBSITE_HTML, "utf8"),
      privacy: "public",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.duplicate).toBe(false);
    expect(first.data.mimeType).toBe("text/html");
    expect(first.data.extractionStatus).toBe("extracted");
    expect(first.data.extractedTextLength).toBeGreaterThan(0);
    expect(first.data.spanCount).toBeGreaterThan(0);

    // Re-uploading the same bytes returns the original and creates nothing.
    const second = await ingest.ingestSource(user, {
      projectId: projectA,
      sourceType: "website",
      filename: "jcluxury-copy.html",
      bytes: Buffer.from(WEBSITE_HTML, "utf8"),
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.duplicate).toBe(true);
    expect(second.data.sourceArtifactId).toBe(first.data.sourceArtifactId);

    const [count] = await sql`
      select count(*)::int as n from source_artifacts where project_id = ${projectA}
    `;
    expect(count!.n).toBe(1);

    // The source.ingested event fires exactly once, for the genuinely new one.
    const events = await sql`
      select id from domain_events where type = 'source.ingested' and project_id = ${projectA}
    `;
    expect(events.length).toBe(1);
  });

  it("keeps a source it cannot parse, rather than losing it", async () => {
    const result = await ingest.ingestSource(user, {
      projectId: projectA,
      sourceType: "image",
      filename: "listing.png",
      bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.mimeType).toBe("image/png");
    // Stored and hashed; explicitly not parsed. No OCR is claimed.
    expect(result.data.extractionStatus).toBe("unsupported");

    const [row] = await sql`
      select sha256, byte_size from source_artifacts where id = ${result.data.sourceArtifactId}
    `;
    expect(row!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Number(row!.byteSize)).toBe(10);
  });

  it("versions a changed source instead of overwriting it", async () => {
    const url = "https://jcluxury.example/about";
    const first = await ingest.ingestSource(user, {
      projectId: projectA,
      sourceType: "website",
      url,
      text: "<html><body><p>Original copy.</p></body></html>",
      declaredMimeType: "text/html",
    });
    const second = await ingest.ingestSource(user, {
      projectId: projectA,
      sourceType: "website",
      url,
      text: "<html><body><p>Revised copy.</p></body></html>",
      declaredMimeType: "text/html",
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    const rows = await sql`
      select id, version, supersedes_id, superseded_at from source_artifacts
      where project_id = ${projectA} order by version asc
    `;
    expect(rows.length).toBe(2);
    expect(rows[1]!.version).toBe(2);
    expect(rows[1]!.supersedesId).toBe(first.data.sourceArtifactId);
    // The predecessor is retained, marked superseded — never deleted.
    expect(rows[0]!.supersededAt).not.toBeNull();
  });

  it("refuses to chain one client's source onto another's", async () => {
    const mine = await ingest.ingestSource(user, {
      projectId: projectA,
      text: "mine",
      filename: "a.txt",
    });
    expect(mine.ok).toBe(true);
    if (!mine.ok) return;

    const theirs = await ingest.ingestSource(user, {
      projectId: projectB,
      text: "theirs",
      filename: "b.txt",
      supersedesId: mine.data.sourceArtifactId,
    });
    expect(theirs.ok).toBe(false);
    if (theirs.ok) return;
    expect(theirs.error.kind).toBe("forbidden");
  });

  it("refuses to fetch a private-network address", async () => {
    const result = await ingest.ingestSource(user, {
      projectId: projectA,
      url: "http://169.254.169.254/latest/meta-data/",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("forbidden");
  });

  // -------------------------------------------------------------- extraction

  it("proposes claims with verified quotes and drops fabricated ones", async () => {
    await entities.upsertEntity(user, {
      projectId: projectA,
      entityType: "organization",
      canonicalName: "Northvale Demo",
    });
    const source = await ingest.ingestSource(user, {
      projectId: projectA,
      sourceType: "website",
      filename: "site.html",
      bytes: Buffer.from(WEBSITE_HTML, "utf8"),
      privacy: "public",
    });
    expect(source.ok).toBe(true);
    if (!source.ok) return;

    const result = await extraction.extractClaimsFromSource(
      user,
      { sourceArtifactId: source.data.sourceArtifactId },
      {
        caller: stubCaller([
          {
            subject: "Northvale Demo",
            predicate: "operates in",
            object: "Jersey City",
            originalWording: "Northvale Demo operates in Jersey City and Hoboken.",
            normalizedWording: "Northvale Demo operates in Jersey City and Hoboken.",
            category: "market",
            asOf: null,
            value: null,
            confidence: 0.95,
            locator: "block 2",
          },
          {
            // Not in the document — a fabrication, and it must not survive.
            subject: "Northvale Demo",
            predicate: "is",
            object: "the top firm",
            originalWording: "Northvale Demo is the number one firm in New Jersey.",
            normalizedWording: "Northvale Demo is the leading firm in New Jersey.",
            category: "ranking",
            asOf: null,
            value: null,
            confidence: 0.9,
            locator: "",
          },
        ]),
      }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.proposed).toHaveLength(1);
    expect(result.data.rejected).toHaveLength(1);
    expect(result.data.rejected[0]!.reason).toContain("does not appear in the source");

    // Everything an agent proposes lands as `proposed`. Nothing is approved.
    const rows = await sql`
      select status, materiality, subject_entity_id, source_artifact_ids
      from claims where project_id = ${projectA}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("proposed");
    expect(rows[0]!.subjectEntityId).not.toBeNull();
    expect((rows[0]!.sourceArtifactIds as string[])[0]).toBe(source.data.sourceArtifactId);
  });

  it("classifies a superlative as high risk regardless of the category given", async () => {
    const source = await ingest.ingestSource(user, {
      projectId: projectA,
      filename: "bio.txt",
      text: "Ana is the leading waterfront agent in Jersey City.",
    });
    expect(source.ok).toBe(true);
    if (!source.ok) return;

    const result = await extraction.extractClaimsFromSource(
      user,
      { sourceArtifactId: source.data.sourceArtifactId },
      {
        caller: stubCaller([
          {
            subject: "Ana",
            predicate: "is",
            object: "leading agent",
            originalWording: "Ana is the leading waterfront agent in Jersey City.",
            normalizedWording: "Ana is the leading waterfront agent in Jersey City.",
            // Filed as an ordinary service claim by the model...
            category: "service",
            asOf: null,
            value: null,
            confidence: 0.9,
            locator: "",
          },
        ]),
      }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // ...and reclassified by deterministic code, which the model cannot game.
    expect(result.data.proposed[0]!.materiality).toBe("high_risk");
    expect(result.data.proposed[0]!.requiresIndependentVerification).toBe(true);
  });

  // ------------------------------------------------------------ compilation

  async function approveClaim(projectId: string, key: string, text: string, extra: Record<string, unknown> = {}) {
    const proposed = await claimSvc.proposeClaim(user, {
      projectId,
      key,
      canonicalText: text,
      evidence: [{ url: "https://example.com/source", note: "seed evidence" }],
      ...extra,
    });
    if (!proposed.ok) throw new Error(proposed.error.message);
    await sql`
      update claims set category = ${(extra.category as string) ?? "market"},
        privacy_status = ${(extra.privacy as string) ?? "public"}
      where id = ${proposed.data.id}
    `;
    const approved = await claimSvc.approveClaim(user, { claimId: proposed.data.id });
    if (!approved.ok) throw new Error(approved.error.message);
    return proposed.data.id;
  }

  it("compiles a wiki with section provenance and no free-floating facts", async () => {
    await approveClaim(projectA, "operates_in", "Northvale Demo operates in Jersey City.");

    const build = await planner.compileAffected({
      projectId: projectA,
      trigger: "initial",
      force: true,
    });
    expect(build.status).toBe("completed");
    expect(build.compiled).toBeGreaterThan(0);
    expect(build.failed).toBe(0);

    const page = await compile.readActivePage({ projectId: projectA, slug: "client-summary" });
    expect(page).not.toBeNull();
    expect(page!.body).toContain("Northvale Demo operates in Jersey City.");
    expect(page!.stale).toBe(false);

    const provenance = await compile.readPageProvenance(page!.versionId);
    const material = provenance.filter((p) => p.material);
    expect(material.length).toBeGreaterThan(0);
    // Every material section names the claims behind it.
    for (const section of material) {
      expect(
        section.claimIds.length + section.evidenceIds.length + section.instructionVersionIds.length,
        section.sectionKey
      ).toBeGreaterThan(0);
      expect(section.compilerVersion).toMatch(/^wiki-compiler/);
    }
  });

  it("produces no new version when nothing changed", async () => {
    await approveClaim(projectA, "operates_in", "Northvale Demo operates in Jersey City.");
    await planner.compileAffected({ projectId: projectA, trigger: "initial", force: true });

    const before = await compile.readActivePage({ projectId: projectA, slug: "client-summary" });
    const second = await planner.compileAffected({
      projectId: projectA,
      trigger: "manual",
      force: true,
    });

    expect(second.compiled).toBe(0);
    expect(second.noOp).toBe(second.requested);
    const after = await compile.readActivePage({ projectId: projectA, slug: "client-summary" });
    // Same version id: history records changes, not scheduled rebuilds.
    expect(after!.versionId).toBe(before!.versionId);
    expect(after!.version).toBe(before!.version);
  });

  it("marks only the pages that depend on a changed claim", async () => {
    await approveClaim(projectA, "operates_in", "Northvale Demo operates in Jersey City.");
    await planner.compileAffected({ projectId: projectA, trigger: "initial", force: true });

    const stalePagesBefore = await stale.stalePages(projectA);
    expect(stalePagesBefore).toHaveLength(0);

    // Approving a claim publishes claim.approved, which marks its dependents.
    await approveClaim(projectA, "specialises_in", "Northvale Demo specialises in waterfront condos.", {
      category: "specialty",
    });

    const stalePagesAfter = await stale.stalePages(projectA);
    expect(stalePagesAfter.length).toBeGreaterThan(0);
    // ...but not every page. The transactions page depends on nothing here.
    const [total] = await sql`
      select count(*)::int as n from wiki_pages where project_id = ${projectA}
    `;
    expect(stalePagesAfter.length).toBeLessThan(total!.n);
    expect(stalePagesAfter[0]!.reason).toContain("claim.");
  });

  it("records a partial build when one page fails, never 'completed'", async () => {
    await approveClaim(projectA, "operates_in", "Northvale Demo operates in Jersey City.");
    const { CLIENT_PAGE_TEMPLATES } = await import("@/lib/knowledge/compiler/templates");
    const victim = CLIENT_PAGE_TEMPLATES.find((t) => t.slug === "markets")!;
    const original = victim.select;
    victim.select = () => {
      throw new Error("deliberate template failure");
    };
    try {
      const build = await planner.compileAffected({
        projectId: projectA,
        trigger: "manual",
        force: true,
      });
      expect(build.status).toBe("partial");
      expect(build.failed).toBe(1);
      // The other pages still compiled — one failure does not stop the build.
      expect(build.compiled).toBeGreaterThan(0);
      const failedItem = build.items.find((i) => i.status === "failed")!;
      expect(failedItem.slug).toBe("markets");
      expect(failedItem.error).toContain("deliberate template failure");
      // And the failed page stays stale, so the next build retries it.
      const stalePages = await stale.stalePages(projectA);
      expect(stalePages.map((p) => p.slug)).toContain("markets");
    } finally {
      victim.select = original;
    }
  });

  it("keeps every historical page version readable", async () => {
    await approveClaim(projectA, "operates_in", "Northvale Demo operates in Jersey City.");
    await planner.compileAffected({ projectId: projectA, trigger: "initial", force: true });
    await approveClaim(projectA, "team_size", "The team has 8 agents.", { category: "team" });
    await planner.compileAffected({ projectId: projectA, trigger: "manual", force: true });

    const versions = await sql`
      select v.version, v.body_markdown from wiki_page_versions v
      join wiki_pages p on p.id = v.page_id
      where p.project_id = ${projectA} and p.slug = 'client-summary'
      order by v.version asc
    `;
    expect(versions.length).toBeGreaterThanOrEqual(2);
    // The first version does not mention the later claim — it is a snapshot,
    // not a live view.
    expect(versions[0]!.bodyMarkdown).not.toContain("8 agents");
  });

  it("refuses to mutate a compiled page version", async () => {
    await approveClaim(projectA, "operates_in", "Northvale Demo operates in Jersey City.");
    await planner.compileAffected({ projectId: projectA, trigger: "initial", force: true });
    const page = await compile.readActivePage({ projectId: projectA, slug: "client-summary" });

    await expect(
      sql`update wiki_page_versions set body_markdown = 'tampered' where id = ${page!.versionId}`
    ).rejects.toThrow(/insert-only/);
    await expect(
      sql`delete from wiki_page_versions where id = ${page!.versionId}`
    ).rejects.toThrow(/insert-only/);
  });

  // ----------------------------------------------------------- instructions

  it("resolves instructions by scope and effective date, excluding unapproved ones", async () => {
    const voice = await instructions.createInstruction(user, {
      projectId: projectA,
      instructionType: "brand_voice",
      scope: "project",
      title: "Brand voice",
      body: "Plain, factual, no superlatives.",
    });
    const gated = await instructions.createInstruction(user, {
      projectId: projectA,
      instructionType: "prohibited_claim",
      scope: "project",
      title: "Awaiting sign-off",
      body: "Never mention the Riverside deal.",
      requiresApproval: true,
    });
    const expired = await instructions.createInstruction(user, {
      projectId: projectA,
      instructionType: "tone",
      scope: "project",
      title: "Old campaign tone",
      body: "Use spring campaign wording.",
      effectiveUntil: "2026-01-01",
    });
    expect(voice.ok && gated.ok && expired.ok).toBe(true);

    const resolved = await instructions.resolveInstructions({ projectId: projectA });
    const titles = resolved.instructions.map((i) => i.title);
    expect(titles).toContain("Brand voice");
    expect(titles).not.toContain("Awaiting sign-off");
    expect(titles).not.toContain("Old campaign tone");

    const reasons = resolved.excluded.map((e) => e.reason).join(" ");
    expect(reasons).toContain("Requires approval");
    expect(reasons).toContain("Expired on 2026-01-01");
  });

  it("preserves the prior instruction version when revising", async () => {
    const created = await instructions.createInstruction(user, {
      projectId: projectA,
      instructionType: "brand_voice",
      scope: "project",
      title: "Brand voice",
      body: "Version one.",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const revised = await instructions.reviseInstruction(user, {
      instructionId: created.data.instructionId,
      body: "Version two.",
      changeReason: "Tightened the wording.",
    });
    expect(revised.ok).toBe(true);

    const versions = await sql`
      select version, body from knowledge_instruction_versions
      where instruction_id = ${created.data.instructionId} order by version asc
    `;
    expect(versions.map((v) => v.body)).toEqual(["Version one.", "Version two."]);
    const active = await instructions.resolveInstructions({ projectId: projectA });
    expect(active.instructions[0]!.body).toBe("Version two.");
  });

  // ---------------------------------------------------------- context packets

  it("builds a task packet that separates instructions from facts and stays in budget", async () => {
    await approveClaim(projectA, "operates_in", "Northvale Demo operates in Jersey City.");
    await instructions.createInstruction(user, {
      projectId: projectA,
      instructionType: "prohibited_claim",
      scope: "project",
      title: "No superlatives",
      body: "Never describe the client as best, top or leading.",
    });
    await planner.compileAffected({ projectId: projectA, trigger: "initial", force: true });

    const { packet, packetId } = await builder.buildValidatedPacket({
      projectId: projectA,
      templateKey: "content_drafting",
      taskObjective: "Draft a Jersey City waterfront buyer guide.",
      agentKey: "content_draft",
    });

    expect(packetId).toMatch(/^[0-9a-f-]{36}$/);
    expect(packet.tokenCount).toBeLessThanOrEqual(packet.tokenBudget);

    const rendered = builder.renderContextPacket(packet);
    // Rules and facts are labelled separately — an agent that cannot tell them
    // apart will restate a rule as a client fact.
    expect(rendered).toContain("# Operating instructions");
    expect(rendered).toContain("never restate them as client facts");
    expect(rendered).toContain("# Approved client facts");
    expect(rendered).toContain("Northvale Demo operates in Jersey City.");
    expect(rendered).toContain("Never describe the client as best, top or leading.");

    // Every item carries a reason for being there.
    const explanation = await builder.explainPacket(packetId);
    expect(explanation.included.length).toBeGreaterThan(0);
    for (const item of explanation.included) {
      expect(item.selectionReason.length, item.itemRef).toBeGreaterThan(0);
      expect(item.selectionReason).toMatch(/^(deterministic|retrieval)/);
    }
  });

  it("withholds a non-public claim from a public-audience packet and records it", async () => {
    await approveClaim(projectA, "operates_in", "Northvale Demo operates in Jersey City.");
    // Same category the template selects, so the claim is genuinely in scope
    // and its exclusion is a privacy decision rather than a scope one.
    await approveClaim(projectA, "private_deal", "Northvale Demo closed a confidential sale.", {
      category: "market",
      privacy: "internal",
    });

    const packet = await builder.buildPacket({
      projectId: projectA,
      templateKey: "content_drafting",
      taskObjective: "Draft a market update.",
    });

    const bodies = packet.items.filter((i) => i.included).map((i) => i.body).join(" ");
    expect(bodies).not.toContain("confidential sale");
    // The omission is auditable, not silent.
    expect(packet.withheldClaimIds.length).toBeGreaterThan(0);
  });

  it("never lets a restricted claim into any packet", async () => {
    await approveClaim(projectA, "operates_in", "Northvale Demo operates in Jersey City.");
    await approveClaim(projectA, "restricted_fact", "Do not disclose: pending litigation.", {
      category: "general",
      privacy: "restricted",
    });

    for (const templateKey of ["content_drafting", "meeting_preparation", "executive_report"]) {
      const packet = await builder.buildPacket({
        projectId: projectA,
        templateKey,
        taskObjective: "Any task.",
        additionalCategories: ["general"],
      });
      const bodies = packet.items.map((i) => i.body).join(" ");
      expect(bodies, templateKey).not.toContain("pending litigation");
    }
  });

  it("excludes a stale claim from a public packet and discloses the exclusion", async () => {
    await approveClaim(projectA, "operates_in", "Northvale Demo operates in Jersey City.");
    const rankingId = await approveClaim(
      projectA,
      "ranking_2023",
      "Northvale Demo ranked #3 in Jersey City.",
      { category: "ranking" }
    );
    await sql`update claims set as_of = '2023-01-01' where id = ${rankingId}`;

    const packet = await builder.buildPacket({
      projectId: projectA,
      templateKey: "content_drafting",
      taskObjective: "Draft a market update.",
      additionalCategories: ["ranking"],
    });

    const bodies = packet.items.filter((i) => i.included).map((i) => i.body).join(" ");
    expect(bodies).not.toContain("ranked #3");
    const disclosed = packet.missingContext.map((m) => m.detail).join(" ");
    expect(disclosed).toContain("ranking_2023");
    expect(disclosed).toMatch(/expired|stale/);
  });

  it("carries an open contradiction into the packet rather than hiding it", async () => {
    const first = await approveClaim(projectA, "operates_in", "Northvale Demo operates in Jersey City.");
    await sql`
      insert into claim_contradictions (project_id, claim_id, severity, description, detected_by)
      values (${projectA}, ${first}, 'high', 'Two sources disagree on the market.', 'value_divergence')
    `;
    const packet = await builder.buildPacket({
      projectId: projectA,
      templateKey: "content_drafting",
      taskObjective: "Draft a market update.",
    });
    const rendered = builder.renderContextPacket(packet);
    expect(rendered).toContain("Unresolved contradictions");
    expect(rendered).toContain("Two sources disagree on the market.");
    expect(packet.requiredDisclaimers.join(" ")).toContain("do not assert the disputed point");
  });

  it("refuses a drafting packet with no approved claims, rather than shipping an empty one", async () => {
    await expect(
      builder.buildValidatedPacket({
        projectId: projectA,
        templateKey: "content_drafting",
        taskObjective: "Draft something.",
      })
    ).rejects.toThrow(/failed validation/);

    const rejected = await sql`
      select payload from domain_events where type = 'context.packet_rejected'
    `;
    expect(rejected.length).toBe(1);
  });

  // ------------------------------------------------------------- isolation

  it("never places one client's claim in another client's packet", async () => {
    await approveClaim(projectA, "operates_in", "Northvale Demo operates in Jersey City.");
    await approveClaim(projectB, "rival_fact", "Hudson Rivals operates in Hoboken.");

    const packet = await builder.buildPacket({
      projectId: projectA,
      templateKey: "meeting_preparation",
      taskObjective: "Prepare for the Northvale Demo meeting.",
    });
    const bodies = packet.items.map((i) => i.body).join(" ");
    expect(bodies).not.toContain("Hudson Rivals");

    const claimIds = packet.items.filter((i) => i.itemType === "claim").map((i) => i.itemRef);
    if (claimIds.length > 0) {
      const owners = await sql`
        select distinct project_id from claims where id = any(${claimIds})
      `;
      expect(owners).toHaveLength(1);
      expect(owners[0]!.projectId).toBe(projectA);
    }
  });

  it("fails validation if a foreign claim is ever smuggled into a packet", async () => {
    await approveClaim(projectA, "operates_in", "Northvale Demo operates in Jersey City.");
    const foreign = await approveClaim(projectB, "rival_fact", "Hudson Rivals operates in Hoboken.");

    const packet = await builder.buildPacket({
      projectId: projectA,
      templateKey: "meeting_preparation",
      taskObjective: "Prepare for the meeting.",
    });
    // Hand-inject the other client's claim, simulating a future selection bug.
    packet.items.push({
      itemType: "claim",
      itemRef: foreign,
      label: "smuggled",
      body: "Hudson Rivals operates in Hoboken.",
      priorityClass: 3,
      selectionReason: "test injection",
      retrievalScore: null,
      tokenCost: 10,
      freshnessStatus: "current",
      privacyStatus: "public",
      included: true,
      exclusionReason: null,
    });

    const validation = await builder.validatePacket(packet);
    expect(validation.valid).toBe(false);
    expect(validation.failures.join(" ")).toContain("does not belong to this client");
  });

  it("keeps one client's compiled pages out of another's", async () => {
    await approveClaim(projectA, "operates_in", "Northvale Demo operates in Jersey City.");
    await approveClaim(projectB, "rival_fact", "Hudson Rivals operates in Hoboken.");
    await planner.compileAffected({ projectId: projectA, trigger: "initial", force: true });
    await planner.compileAffected({ projectId: projectB, trigger: "initial", force: true });

    const a = await compile.readActivePage({ projectId: projectA, slug: "client-summary" });
    const b = await compile.readActivePage({ projectId: projectB, slug: "client-summary" });
    expect(a!.body).toContain("Jersey City");
    expect(a!.body).not.toContain("Hudson Rivals");
    expect(b!.body).toContain("Hoboken");
    expect(b!.body).not.toContain("Northvale Demo operates");
  });

  // ---------------------------------------------------------- contradictions

  it("detects a contradiction between two approved claims at runtime", async () => {
    const first = await approveClaim(projectA, "brokerage_a", "Ana works for Brokerage X.", {
      category: "affiliation",
    });
    const second = await approveClaim(projectA, "brokerage_b", "Ana works for Brokerage Y.", {
      category: "affiliation",
    });
    await sql`
      update claims set normalized_predicate = 'works_for', subject_entity = 'Ana',
        as_of = '2026-01-01'
      where id in (${first}, ${second})
    `;

    const scan = await contradictions.scanProjectContradictions(projectA);
    expect(scan.recorded).toBeGreaterThan(0);

    const rows = await sql`
      select severity, description, detected_by from claim_contradictions
      where project_id = ${projectA} and status = 'open'
    `;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.severity).toBe("critical");
    expect(rows[0]!.description).toContain("Likely explanation");
    expect(rows[0]!.description).toContain("Recommended");

    // Re-scanning does not duplicate an open contradiction.
    const again = await contradictions.scanProjectContradictions(projectA);
    expect(again.recorded).toBe(0);
  });

  // ----------------------------------------------------------- measurement

  it("measures token counts across the four context strategies", async () => {
    await ingest.ingestSource(user, {
      projectId: projectA,
      sourceType: "website",
      filename: "site.html",
      bytes: Buffer.from(WEBSITE_HTML.repeat(20), "utf8"),
    });
    await approveClaim(projectA, "operates_in", "Northvale Demo operates in Jersey City.");
    await planner.compileAffected({ projectId: projectA, trigger: "initial", force: true });

    const result = await experiment.compareContextModes({
      projectId: projectA,
      templateKey: "content_drafting",
      taskObjective: "Draft a Jersey City buyer guide.",
    });

    const byMode = Object.fromEntries(result.modes.map((m) => [m.mode, m]));
    expect(byMode.raw_documents!.inputTokens).toBeGreaterThan(0);
    expect(byMode.task_packet!.inputTokens).toBeGreaterThan(0);
    // The measured direction, not an asserted percentage.
    expect(byMode.task_packet!.inputTokens).toBeLessThan(byMode.raw_documents!.inputTokens);
    expect(result.reductionVsRaw.task_packet).toBeGreaterThan(0);

    // The result states plainly that quality was not measured.
    expect(result.qualityMeasured).toBe(false);
    expect(experiment.formatComparison(result)).toContain("NOT measured");
  });

  // ------------------------------------------------------- end-to-end demo

  it("runs the full chain: source → claim → approval → compile → packet", async () => {
    // 1-3. A source arrives, is stored, hashed and extracted.
    await entities.upsertEntity(user, {
      projectId: projectA,
      entityType: "organization",
      canonicalName: "Northvale Demo",
    });
    const source = await ingest.ingestSource(user, {
      projectId: projectA,
      sourceType: "website",
      filename: "site.html",
      bytes: Buffer.from(WEBSITE_HTML, "utf8"),
      privacy: "public",
    });
    expect(source.ok).toBe(true);
    if (!source.ok) return;
    expect(source.data.extractionStatus).toBe("extracted");

    // 4-6. Entities resolved, claims proposed, evidence linked.
    const proposed = await extraction.extractClaimsFromSource(
      user,
      { sourceArtifactId: source.data.sourceArtifactId },
      {
        caller: stubCaller([
          {
            subject: "Northvale Demo",
            predicate: "operates in",
            object: "Jersey City",
            originalWording: "Northvale Demo operates in Jersey City and Hoboken.",
            normalizedWording: "Northvale Demo operates in Jersey City and Hoboken.",
            category: "market",
            asOf: "2026-01-01",
            value: null,
            confidence: 0.95,
            locator: "block 2",
          },
        ]),
      }
    );
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;
    const claimId = proposed.data.proposed[0]!.claimId;

    // 7-9. A human approves; the agent could not.
    const approval = await claimSvc.approveClaim(user, { claimId });
    expect(approval.ok).toBe(true);

    // 10-12. Canonical change marks pages stale; only affected pages rebuild.
    const build = await planner.compileAffected({ projectId: projectA, trigger: "event" });
    expect(build.status).toBe("completed");
    expect(build.compiled).toBeGreaterThan(0);

    // 13. Hot files are current.
    const summary = await compile.readActivePage({
      projectId: projectA,
      slug: "client-summary",
    });
    expect(summary!.stale).toBe(false);
    expect(summary!.body).toContain("Jersey City");
    expect(summary!.tokenCount).toBeLessThanOrEqual(2_000);

    // 14-17. A content task builds a packet and the agent receives it.
    await instructions.createInstruction(user, {
      projectId: projectA,
      instructionType: "prohibited_claim",
      scope: "project",
      title: "No superlatives",
      body: "Never say best, top or leading.",
    });
    const { packet, packetId } = await builder.buildValidatedPacket({
      projectId: projectA,
      templateKey: "content_drafting",
      taskObjective: "Draft a Jersey City waterfront guide.",
      agentKey: "content_draft",
    });
    expect(packet.tokenCount).toBeLessThanOrEqual(packet.tokenBudget);

    // 23. The packet and the page version stay reproducible.
    const stored = await sql`
      select content_hash, token_count, template_key from evidence_packets where id = ${packetId}
    `;
    expect(stored[0]!.contentHash).toBe(packet.contentHash);
    expect(stored[0]!.templateKey).toBe("content_drafting");

    // 24. Another client cannot read it.
    const foreign = await sql`
      select id from evidence_packets where id = ${packetId} and project_id = ${projectB}
    `;
    expect(foreign).toHaveLength(0);

    // 25. And the token comparison is measurable.
    const comparison = await experiment.compareContextModes({
      projectId: projectA,
      templateKey: "content_drafting",
      taskObjective: "Draft a Jersey City waterfront guide.",
    });
    expect(comparison.modes.every((m) => m.inputTokens >= 0)).toBe(true);
  }, 60_000);
});
