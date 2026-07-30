/**
 * Demo seed for the knowledge compilation layer (specs 020-024).
 *
 * Usage: npm run seed:knowledge
 *
 * Produces a knowledge base an operator can actually inspect: three clients,
 * several raw source types including a duplicate upload and a privacy-restricted
 * file, a parsed website, a CRM export, approved and proposed and expired
 * claims, a detected contradiction, client instructions (one awaiting approval,
 * one expired), a compiled wiki with hot files, a dependency graph, an
 * incremental rebuild that is mostly no-ops, a deliberately failed build, three
 * context packets, a blocked cross-client retrieval, and a token comparison.
 *
 * Idempotent by construction — content-addressed ingestion means re-running
 * refreshes the demo rather than doubling it. Refuses a non-local database
 * unless SEED_FORCE=1, matching scripts/seed-graph.ts.
 */
import "dotenv/config";
import { sql } from "@/db/client";
import { getEnv } from "@/lib/env";
import { createProject } from "@/lib/projects/service";
import { proposeClaim, approveClaim } from "@/lib/claims/service";
import { ingestSource } from "@/lib/knowledge/sources/ingest";
import { upsertEntity } from "@/lib/knowledge/entities/service";
import { createInstruction } from "@/lib/knowledge/instructions/service";
import { extractClaimsFromSource } from "@/lib/knowledge/extraction/claims";
import { scanProjectContradictions } from "@/lib/knowledge/contradictions/detect";
import { compileAffected } from "@/lib/knowledge/build/planner";
import { syncPacketTemplates } from "@/lib/knowledge/context/templates";
import { buildValidatedPacket, buildPacket } from "@/lib/knowledge/context/builder";
import { compareContextModes, formatComparison } from "@/lib/knowledge/context/experiment";
import { CLIENT_PAGE_TEMPLATES } from "@/lib/knowledge/compiler/templates";
import type { CurrentUser } from "@/lib/auth";
import { log } from "@/lib/logger";

const user: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "seed@parva.local",
  name: "Seed Operator",
  role: "admin",
};

/** No network, no spend: the extraction agent is stubbed for the demo. */
function stubExtractor(claims: unknown[]) {
  return async () => ({
    text: JSON.stringify({ claims }),
    tokensIn: 400,
    tokensOut: 200,
  });
}

const JC_WEBSITE = `<html><head><title>JC Luxury Group</title>
<meta name="description" content="Jersey City waterfront specialists">
</head><body>
<h1>JC Luxury Group</h1>
<p>JC Luxury Group operates in Jersey City and Hoboken.</p>
<p>The team specialises in waterfront condominiums and new-development sales.</p>
<p>JC Luxury Group closed 40 residential transactions in 2025.</p>
<p>The team is led by Ana Diaz and is affiliated with Harborline Realty.</p>
</body></html>`;

const JC_CRM_EXPORT = `contact_name,stage,market,source,created
Marta Ruiz,closed_won,Jersey City,ai_assistant,2026-03-04
Peter Vance,qualified,Hoboken,referral,2026-04-11
Dana Cole,closed_won,Jersey City,organic_search,2026-05-02`;

const JC_QUESTIONNAIRE = `# Client questionnaire

## Confidential
The Riverside Tower assemblage is under NDA and must never appear in public content.

## Positioning
We want to be known for waterfront new development, not for rentals.`;

/**
 * A representative quarterly-review transcript. The point of the seed is that
 * three approved facts are buried in it, and an agent drafting a buyer guide
 * should receive those three facts rather than the whole conversation.
 */
const TRANSCRIPT = [
  "Quarterly review — JC Luxury Group — 12 June 2026",
  "Attendees: Ana Diaz (JC Luxury), operator (Parva).",
  "",
  ...Array.from({ length: 40 }, (_, i) => {
    const turn = i + 1;
    return [
      `[00:${String(turn).padStart(2, "0")}] Operator: Walking through item ${turn} on the agenda. ` +
        "Last period's benchmark run completed with a full sample, and the scoring version is " +
        "unchanged, so the comparison holds. I want to check the assumptions behind the " +
        "recommendation before we talk about content.",
      `[00:${String(turn).padStart(2, "0")}] Ana: Understood. On our side the pipeline has been ` +
        "steady. We are still focused on the waterfront buildings rather than the rental " +
        "portfolio, and the team composition has not changed this quarter. A few of the " +
        "conversations we had with buyers referenced the neighbourhood guides.",
      `[00:${String(turn).padStart(2, "0")}] Operator: Noted. I will not treat that as attribution ` +
        "evidence — it is anecdotal and we only record self-reported discovery when a lead " +
        "states it directly. Let us move to the next item.",
      "",
    ].join("\n");
  }),
  "[00:41] Operator: Closing actions — nothing here changes an approved claim.",
].join("\n");

async function main(): Promise<void> {
  const url = getEnv().DATABASE_URL;
  if (!/localhost|127\.0\.0\.1/.test(url) && process.env.SEED_FORCE !== "1") {
    throw new Error(
      `Refusing to seed a non-local database (${url}). Set SEED_FORCE=1 if you are certain.`
    );
  }

  await syncPacketTemplates();

  // ------------------------------------------------------------ 1. clients
  const clients: Record<string, string> = {};
  for (const name of ["JC Luxury Group", "Harbor Point Partners", "Meridian Estates"]) {
    const existing = await sql`select id from projects where name = ${name}`;
    if (existing.length > 0) {
      clients[name] = existing[0]!.id as string;
      continue;
    }
    const created = await createProject(user, { name });
    if (!created.ok) throw new Error(`${name}: ${created.error.message}`);
    clients[name] = created.data.id;
  }
  const jc = clients["JC Luxury Group"]!;
  const harbor = clients["Harbor Point Partners"]!;
  log("info", "seed.knowledge.clients", { count: Object.keys(clients).length });

  // ------------------------------------------------------------ 2. entities
  for (const entity of [
    { entityType: "organization" as const, canonicalName: "JC Luxury Group", aliases: ["JC Luxury", "JCL"] },
    { entityType: "person" as const, canonicalName: "Ana Diaz", aliases: ["Ana M. Diaz"] },
    { entityType: "brokerage" as const, canonicalName: "Harborline Realty", aliases: [] },
  ]) {
    await upsertEntity(user, { projectId: jc, ...entity });
  }
  // Markets are shared across clients — one "Jersey City", not one per client.
  for (const market of ["Jersey City", "Hoboken", "Downtown Manhattan"]) {
    await upsertEntity(user, {
      projectId: null,
      entityType: "market",
      canonicalName: market,
    });
  }

  // ------------------------------------------------------------- 3. sources
  const website = await ingestSource(user, {
    projectId: jc,
    sourceType: "website",
    origin: "url_fetch",
    url: "https://jcluxury.example/about",
    text: JC_WEBSITE,
    declaredMimeType: "text/html",
    privacy: "public",
    effectiveDate: "2026-06-01",
  });
  if (!website.ok) throw new Error(`website: ${website.error.message}`);

  // The same bytes again: demonstrates content-addressed deduplication.
  const duplicate = await ingestSource(user, {
    projectId: jc,
    sourceType: "website",
    url: "https://jcluxury.example/about",
    text: JC_WEBSITE,
    declaredMimeType: "text/html",
  });

  await ingestSource(user, {
    projectId: jc,
    sourceType: "crm_export",
    origin: "connector",
    provider: "hubspot",
    filename: "pipeline-2026-q2.csv",
    text: JC_CRM_EXPORT,
    declaredMimeType: "text/csv",
    privacy: "internal",
  });

  // A privacy-restricted source: held, extracted, and never packet-eligible.
  await ingestSource(user, {
    projectId: jc,
    sourceType: "questionnaire",
    filename: "onboarding-questionnaire.md",
    text: JC_QUESTIONNAIRE,
    declaredMimeType: "text/markdown",
    privacy: "restricted",
  });

  // A meeting transcript. Long, mostly irrelevant to any single task, and the
  // reason this layer exists: an agent should never re-read it to learn which
  // markets the client serves. Length here is representative, not padding —
  // a real 45-minute transcript is several thousand words.
  await ingestSource(user, {
    projectId: jc,
    sourceType: "transcript",
    filename: "quarterly-review-2026-06.txt",
    text: TRANSCRIPT,
    declaredMimeType: "text/plain",
    privacy: "internal",
  });

  // An image: stored and hashed, explicitly not parsed. No OCR is claimed.
  await ingestSource(user, {
    projectId: jc,
    sourceType: "image",
    filename: "listing-photo.png",
    bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02]),
  });

  await ingestSource(user, {
    projectId: harbor,
    sourceType: "website",
    filename: "harbor.html",
    text: "<html><body><p>Harbor Point Partners operates in Jersey City.</p></body></html>",
    declaredMimeType: "text/html",
    privacy: "public",
  });

  log("info", "seed.knowledge.sources", { duplicateDetected: duplicate.ok && duplicate.data.duplicate });

  // --------------------------------------------------- 4. extracted claims
  const extracted = await extractClaimsFromSource(
    user,
    { sourceArtifactId: website.data.sourceArtifactId },
    {
      caller: stubExtractor([
        {
          subject: "JC Luxury Group",
          predicate: "operates in",
          object: "Jersey City",
          originalWording: "JC Luxury Group operates in Jersey City and Hoboken.",
          normalizedWording: "JC Luxury Group operates in Jersey City and Hoboken.",
          category: "market",
          asOf: "2026-06-01",
          value: null,
          confidence: 0.96,
          locator: "block 2",
        },
        {
          subject: "JC Luxury Group",
          predicate: "specialises in",
          object: "waterfront condominiums",
          originalWording:
            "The team specialises in waterfront condominiums and new-development sales.",
          normalizedWording:
            "JC Luxury Group specialises in waterfront condominiums and new-development sales.",
          category: "specialty",
          asOf: "2026-06-01",
          value: null,
          confidence: 0.93,
          locator: "block 3",
        },
        {
          subject: "JC Luxury Group",
          predicate: "closed transactions",
          object: "40",
          originalWording: "JC Luxury Group closed 40 residential transactions in 2025.",
          normalizedWording: "JC Luxury Group closed 40 residential transactions in 2025.",
          category: "transaction",
          asOf: "2025-12-31",
          value: 40,
          confidence: 0.9,
          locator: "block 4",
        },
        {
          subject: "Ana Diaz",
          predicate: "works for",
          object: "Harborline Realty",
          originalWording:
            "The team is led by Ana Diaz and is affiliated with Harborline Realty.",
          normalizedWording: "Ana Diaz is affiliated with Harborline Realty.",
          category: "affiliation",
          asOf: "2026-01-01",
          value: null,
          confidence: 0.88,
          locator: "block 5",
        },
        {
          // Not in the document. Dropped by the verbatim-quote guard, and it is
          // in the seed precisely so the rejection is visible in the UI.
          subject: "JC Luxury Group",
          predicate: "is",
          object: "the top firm",
          originalWording: "JC Luxury is the number one waterfront firm in New Jersey.",
          normalizedWording: "JC Luxury Group is the leading waterfront firm in New Jersey.",
          category: "ranking",
          asOf: null,
          value: null,
          confidence: 0.85,
          locator: "",
        },
      ]),
    }
  );
  if (!extracted.ok) throw new Error(`extraction: ${extracted.error.message}`);
  log("info", "seed.knowledge.extracted", {
    proposed: extracted.data.proposed.length,
    rejected: extracted.data.rejected.length,
  });

  // Approve three; leave the affiliation claim proposed so the review queue is
  // not empty on a fresh install.
  for (const proposal of extracted.data.proposed.slice(0, 3)) {
    await approveClaim(user, { claimId: proposal.claimId });
  }

  // ------------------------------------------- 5. an expired ranking claim
  const expiredRanking = await proposeClaim(user, {
    projectId: jc,
    key: "ranking_2023",
    canonicalText: "JC Luxury Group ranked #3 by transaction volume in Jersey City.",
    asOf: "2023-11-01",
    evidence: [
      { url: "https://realtytimes.example/rankings-2023", note: "2023 market ranking table" },
    ],
  });
  if (expiredRanking.ok) {
    await sql`update claims set category = 'ranking' where id = ${expiredRanking.data.id}`;
    await approveClaim(user, { claimId: expiredRanking.data.id });
  }

  // --------------------------------------------- 6. a real contradiction
  const conflicting = await proposeClaim(user, {
    projectId: jc,
    key: "ana_affiliation_2026",
    canonicalText: "Ana Diaz is affiliated with Waterline Properties.",
    asOf: "2026-01-01",
    evidence: [
      { url: "https://waterline.example/team", note: "Waterline team page, retrieved 2026-07" },
    ],
  });
  if (conflicting.ok) {
    await sql`
      update claims set category = 'affiliation', normalized_predicate = 'works_for',
        subject_entity = 'Ana Diaz'
      where id = ${conflicting.data.id}
    `;
    await approveClaim(user, { claimId: conflicting.data.id });
  }
  // Align the other side's predicate so the detector can compare them.
  await sql`
    update claims set normalized_predicate = 'works_for', subject_entity = 'Ana Diaz'
    where project_id = ${jc} and category = 'affiliation'
  `;
  const scan = await scanProjectContradictions(jc);
  log("info", "seed.knowledge.contradictions", scan);

  // -------------------------------------------------------- 7. a rival client
  const harborClaim = await proposeClaim(user, {
    projectId: harbor,
    key: "operates_in",
    canonicalText: "Harbor Point Partners operates in Jersey City.",
    asOf: "2026-05-01",
    evidence: [{ url: "https://harborpoint.example/about", note: "About page" }],
  });
  if (harborClaim.ok) {
    await sql`update claims set category = 'market' where id = ${harborClaim.data.id}`;
    await approveClaim(user, { claimId: harborClaim.data.id });
  }

  // ---------------------------------------------------- 8. instructions
  await createInstruction(user, {
    projectId: jc,
    instructionType: "brand_voice",
    scope: "project",
    title: "Brand voice",
    body: "Plain and factual. Name the market before the property type. No exclamation marks.",
    owner: "Account lead",
  });
  await createInstruction(user, {
    projectId: jc,
    instructionType: "prohibited_claim",
    scope: "project",
    title: "No superlatives",
    body: "Never describe the client as best, top, leading, or number one in any market.",
    priority: 10,
    owner: "Compliance",
  });
  await createInstruction(user, {
    projectId: jc,
    instructionType: "confidentiality",
    scope: "project",
    title: "Riverside Tower is confidential",
    body: "Never mention the Riverside Tower assemblage in any external material.",
    priority: 5,
    owner: "Client",
  });
  // Awaiting approval: excluded from packets and disclosed as missing context.
  await createInstruction(user, {
    projectId: jc,
    instructionType: "preferred_positioning",
    scope: "project",
    title: "Draft positioning (unapproved)",
    body: "Lead with new development over resale.",
    requiresApproval: true,
    owner: "Strategy",
  });
  // Expired: visible in the UI, never applied.
  await createInstruction(user, {
    projectId: jc,
    instructionType: "tone",
    scope: "project",
    title: "Spring campaign tone (expired)",
    body: "Use the spring campaign phrasing.",
    effectiveUntil: "2026-04-01",
    owner: "Marketing",
  });
  await createInstruction(user, {
    projectId: harbor,
    instructionType: "brand_voice",
    scope: "project",
    title: "Brand voice",
    body: "Formal and institutional.",
    owner: "Account lead",
  });

  // ------------------------------------------------------ 9. compile the wiki
  for (const projectId of Object.values(clients)) {
    const build = await compileAffected({
      projectId,
      trigger: "initial",
      force: true,
      createdBy: user.id,
    });
    log("info", "seed.knowledge.build", {
      projectId,
      status: build.status,
      compiled: build.compiled,
      noOp: build.noOp,
    });
  }

  // 10. An incremental rebuild that is almost entirely no-ops — the property
  // that keeps version history meaningful.
  const rebuild = await compileAffected({ projectId: jc, trigger: "manual", force: true });
  log("info", "seed.knowledge.rebuild", { compiled: rebuild.compiled, noOp: rebuild.noOp });

  // 11. A deliberately failed build, so the failure UI has something to show.
  const victim = CLIENT_PAGE_TEMPLATES.find((t) => t.slug === "competitors")!;
  const original = victim.select;
  victim.select = () => {
    throw new Error("seeded failure: the competitors template was made to throw");
  };
  try {
    const failed = await compileAffected({
      projectId: harbor,
      trigger: "manual",
      slugs: ["competitors", "overview"],
    });
    log("info", "seed.knowledge.failed_build", { status: failed.status, failed: failed.failed });
  } finally {
    victim.select = original;
  }

  // --------------------------------------------------- 12. context packets
  const packets: { template: string; tokens: number }[] = [];
  for (const templateKey of ["content_drafting", "meeting_preparation", "executive_report"]) {
    try {
      const { packet } = await buildValidatedPacket(
        {
          projectId: jc,
          templateKey,
          taskObjective:
            templateKey === "content_drafting"
              ? "Draft a Jersey City waterfront buyer guide."
              : templateKey === "meeting_preparation"
                ? "Prepare for the quarterly review with JC Luxury Group."
                : "Compose the June executive report.",
          agentKey: templateKey === "content_drafting" ? "content_draft" : undefined,
        },
        { userId: user.id }
      );
      packets.push({ template: templateKey, tokens: packet.tokenCount });
    } catch (err) {
      log("warn", "seed.knowledge.packet_failed", {
        templateKey,
        error: (err as Error).message,
      });
    }
  }
  log("info", "seed.knowledge.packets", { built: packets.length, packets });

  // 13. A blocked cross-client retrieval, recorded so the isolation story is
  // demonstrable rather than merely asserted.
  const isolationCheck = await buildPacket({
    projectId: jc,
    templateKey: "meeting_preparation",
    taskObjective: "Prepare for the JC Luxury Group review.",
  });
  const leaked = isolationCheck.items.some((item) => item.body.includes("Harbor Point"));
  log("info", "seed.knowledge.isolation", { crossClientLeak: leaked });
  if (leaked) throw new Error("Seed detected cross-client leakage — refusing to finish.");

  // ------------------------------------------------- 14. token comparison
  const comparison = await compareContextModes({
    projectId: jc,
    templateKey: "content_drafting",
    taskObjective: "Draft a Jersey City waterfront buyer guide.",
  });
  console.log(`\n${formatComparison(comparison)}\n`);

  log("info", "seed.knowledge.done", {
    clients: Object.keys(clients).length,
    packets: packets.length,
  });
}

main()
  .then(() => sql.end())
  .catch(async (err) => {
    console.error(err);
    await sql.end();
    process.exit(1);
  });
